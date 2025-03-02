import React, { useState, useEffect, useRef } from "react";
// import axios from "axios";
import ChatInputWidget from "./ChatInputWidget";
import useAudioStore from "./store/audioStore";
import ReactMarkdown from "react-markdown";
import "../styles/Chat.css";

const Chat = () => {
  const [chats, setChats] = useState([
    { msg: "Hi there! How can I assist you today?", who: "bot" },
  ]);
  const [loading, setLoading] = useState(false);
  const [isChatVisible, setIsChatVisible] = useState(false);
  const chatContentRef = useRef(null);
  const { setAudioStream, stopAudio } = useAudioStore();

  // Add WebRTC state
  const [isWebRTCActive, setIsWebRTCActive] = useState(false);
  const [peerConnection, setPeerConnection] = useState(null);
  const [dataChannel, setDataChannel] = useState(null);
  const [micStream, setMicStream] = useState(null);
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);

  const scrollToBottom = () => {
    if (chatContentRef.current) {
      chatContentRef.current.scrollTo({
        top: chatContentRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [chats, loading]);

  // Modify the data channel message handler
  const addMessageToChat = (text, isUser = false) => {
    if (!text) return; // Don't add empty messages

    setChats((prev) => {
      const lastMessage = prev[prev.length - 1];

      // If the last message is from the same sender and incomplete, append to it
      if (
        lastMessage &&
        lastMessage.who === (isUser ? "me" : "bot") &&
        !lastMessage.complete
      ) {
        return [
          ...prev.slice(0, -1),
          { ...lastMessage, msg: lastMessage.msg + text },
        ];
      }

      // Otherwise, add a new message
      return [
        ...prev,
        {
          msg: text,
          who: isUser ? "me" : "bot",
          complete: isUser, // User messages are always complete, bot messages may not be
        },
      ];
    });
  };

  // Add this function to handle search
  const handleSearch = async (query) => {
    try {
      const response = await fetch(
        "https://realtime-api-0j11.onrender.com/api/search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        }
      );

      const data = await response.json();
      return {
        success: true,
        results: data.results,
      };
    } catch (error) {
      console.error("Search error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  };

  // Create data channel handler
  const createDataChannel = (pc) => {
    const channel = pc.createDataChannel("response");

    channel.addEventListener("open", () => {
      console.log("Data channel opened");
      configureData(channel);
    });

    channel.addEventListener("message", async (ev) => {
      const msg = JSON.parse(ev.data);
      console.log("Received message type:", msg.type);

      switch (msg.type) {
        case "session.created":
        case "session.updated":
          console.log(`Session ${msg.type.split(".")[1]}:`, msg.event_id);
          break;

        case "conversation.item.input_audio_transcription.completed":
          addMessageToChat(msg.transcript, true);
          break;

        case "response.text.delta":
          // For streaming text responses
          setChats((prev) => {
            const lastMessage = prev[prev.length - 1];
            if (
              lastMessage &&
              lastMessage.who === "bot" &&
              !lastMessage.complete
            ) {
              // Append to the last bot message
              return [
                ...prev.slice(0, -1),
                { ...lastMessage, msg: lastMessage.msg + msg.delta },
              ];
            } else {
              // Start a new bot message
              return [...prev, { msg: msg.delta, who: "bot", complete: false }];
            }
          });
          break;

        case "response.done":
          // Mark the last message as complete
          setChats((prev) => {
            const lastMessage = prev[prev.length - 1];
            if (lastMessage && lastMessage.who === "bot") {
              return [...prev.slice(0, -1), { ...lastMessage, complete: true }];
            }
            return prev;
          });

          // Handle any final output content
          if (msg.response?.output?.[0]?.content) {
            msg.response.output[0].content.forEach((content) => {
              if (content.type === "text") {
                addMessageToChat(content.text, false);
              } else if (content.type === "audio" && content.transcript) {
                addMessageToChat(content.transcript, false);
              }
            });
          }
          break;
        case "response.audio_transcript.delta":
          console.log("Audio transcript delta received");
          console.log("Peer connection state:", pc.connectionState);
          const remoteStreams = pc.getRemoteStreams();
          console.log("Remote streams:", remoteStreams);

          if (remoteStreams.length > 0) {
            setAudioStream(remoteStreams[0]);
            console.log("Audio stream set from remote streams");
          } else {
            console.log("No remote streams found");
          }
          break;

        case "output_audio_buffer.stopped":
          console.log("Audio buffer stopped, stopping visualization");
          stopAudio();
          break;

        case "response.function_call_arguments.done":
          // Handle function calls
          if (msg.name === "search_hospital") {
            console.log(`Calling search function with args:`, msg.arguments);
            console.log(
              "DataChannel state before search:",
              channel?.readyState
            );
            const args = JSON.parse(msg.arguments);
            const result = await handleSearch(args.query);
            console.log("DataChannel state after search:", channel?.readyState);
            console.log("Result", result);

            // Send function call result back
            const event = {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: msg.call_id,
                output: JSON.stringify(result),
              },
            };
            channel.send(JSON.stringify(event));

            // Request continuation of the response
            const createResponse = {
              type: "response.create",
              response: {
                modalities: ["text", "audio"],
              },
            };
            channel.send(JSON.stringify(createResponse));
          }
          break;

        default:
          console.log("Unhandled message type:", msg.type);
      }
    });

    setDataChannel(channel);
  };

  // Configure data channel
  const configureData = (channel) => {
    const event = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        turn_detection: null,
        input_audio_transcription: {
          model: "whisper-1",
        },
        tools: [
          {
            type: "function",
            name: "search_hospital",
            description:
              "Search through the knowledge base of hospital to find relevant information",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The search query to find relevant information",
                },
              },
              required: ["query"],
            },
          },
        ],
      },
    };
    channel.send(JSON.stringify(event));
  };

  // Modify startWebRTC to mute the mic by default
  const startWebRTC = async () => {
    const pc = new RTCPeerConnection();
    setPeerConnection(pc);

    pc.ontrack = (event) => {
      const el = document.createElement("audio");
      el.srcObject = event.streams[0];
      el.autoplay = true;
      el.style.display = "none";
      document.body.appendChild(el);
    };

    createDataChannel(pc);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);

      // Mute the microphone by default
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });

      stream
        .getTracks()
        .forEach((track) =>
          pc.addTransceiver(track, { direction: "sendrecv" })
        );

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch(
        "https://realtime-api-0j11.onrender.com/api/rtc-connect",
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            "Content-Type": "application/sdp",
          },
        }
      );

      const answer = await response.text();
      await pc.setRemoteDescription({ sdp: answer, type: "answer" });

      setIsWebRTCActive(true);
    } catch (error) {
      console.error("Error starting WebRTC:", error);
    }
  };

  // Add a function to toggle microphone
  const toggleMicrophone = (enabled) => {
    setIsMicMuted(!enabled);
    if (micStream) {
      micStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
  };

  // Handle VAD activation from ChatInputWidget
  const handleNewMessage = async (data) => {
    setIsChatVisible(true);

    if (!isWebRTCActive || !dataChannel) {
      alert("Please start the connection first");
      return;
    }

    if (data.type === "session.update") {
      // Handle VAD updates
      dataChannel.send(JSON.stringify(data));

      // Enable/disable microphone based on VAD state
      const vadEnabled = data.session.turn_detection !== null;
      toggleMicrophone(vadEnabled);
    } else if (data.text && data.text.trim().length > 0) {
      // Handle text messages (existing code)
      addMessageToChat(data.text, true);

      const createMessage = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: data.text,
            },
          ],
        },
      };

      dataChannel.send(JSON.stringify(createMessage));

      const createResponse = {
        type: "response.create",
        response: {
          modalities: ["text", "audio"],
        },
      };

      dataChannel.send(JSON.stringify(createResponse));
    } else if (data.audioFile) {
      // Handle audio file if needed
      // Add a temporary message showing that audio is being processed
      addMessageToChat("🎤 Audio message sent...", true);
    }
  };

  // Add cleanup function
  useEffect(() => {
    return () => {
      if (peerConnection) {
        console.log("Closing peer connection");
        peerConnection.close();
      }
      if (dataChannel) {
        console.log("Closing data channel");
        dataChannel.close();
      }
    };
  }, [peerConnection, dataChannel]);

  const toggleChatVisibility = async () => {
    const newVisibility = !isChatVisible;
    setIsChatVisible(newVisibility);

    // Start WebRTC connection when chat is opened
    if (newVisibility && !isWebRTCActive) {
      setIsConnecting(true);
      await startWebRTC();
      setIsConnecting(false);
    } else if (!newVisibility) {
      // Cleanup WebRTC when chat is collapsed
      if (peerConnection) {
        peerConnection.close();
      }
      if (dataChannel) {
        dataChannel.close();
      }
      setPeerConnection(null);
      setDataChannel(null);
      setIsWebRTCActive(false);
    }
  };

  // const base64ToBlob = (base64, mimeType) => {
  //   const byteCharacters = atob(base64);
  //   const byteArrays = [];
  //   for (let offset = 0; offset < byteCharacters.length; offset += 512) {
  //     const slice = byteCharacters.slice(offset, offset + 512);
  //     const byteNumbers = new Array(slice.length)
  //       .fill()
  //       .map((_, i) => slice.charCodeAt(i));
  //     const byteArray = new Uint8Array(byteNumbers);
  //     byteArrays.push(byteArray);
  //   }
  //   return new Blob(byteArrays, { type: mimeType });
  // };

  return (
    <div className="chat-wrapper">
      {isChatVisible && (
        <div className="chat-content" ref={chatContentRef}>
          {chats.map((chat, index) => (
            <div key={index} className={`chat-message ${chat.who}`}>
              {chat.who === "bot" && (
                <figure className="avatar">
                  <img src="./avatar.gif" alt="avatar" />
                </figure>
              )}
              <div className="message-text">
                {chat.who === "bot" ? (
                  <ReactMarkdown>{chat.msg}</ReactMarkdown>
                ) : (
                  chat.msg
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="chat-message loading">
              <figure className="avatar">
                <img src="./avatar.gif" alt="avatar" />
              </figure>
              <div
                style={{
                  padding: "5px",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <lottie-player
                  src="https://lottie.host/47000d95-a3cd-43b8-ba63-fc7b3216f1cf/6gPsoPB6JM.json"
                  style={{ width: "130px", height: "130px" }}
                  loop
                  autoplay
                  speed="1"
                  direction="1"
                  mode="normal"
                ></lottie-player>
              </div>
            </div>
          )}
        </div>
      )}
      <div className={`chat-footer ${isChatVisible ? "visible" : ""}`}>
        <ChatInputWidget
          onSendMessage={handleNewMessage}
          isDisabled={isConnecting}
        />
      </div>
      <div className="toggle-button-container" onClick={toggleChatVisibility}>
        {!isChatVisible && <span className="toggle-text">Let's chat!</span>}
        <button className="toggle-button">{isChatVisible ? "-" : "+"}</button>
      </div>
    </div>
  );
};

export default Chat;
