from flask import Flask, request, Response, jsonify
from flask_cors import CORS
import requests
import os
import json
import logging
from dotenv import load_dotenv
from langchain_openai import OpenAIEmbeddings
from langchain_qdrant import Qdrant 
import qdrant_client

# Load environment variables from .env file (optional)
load_dotenv()

app = Flask(__name__)

# Configure CORS to allow all origins (for development only)
CORS(app, resources={
    r"/api/*": {
        "origins": "http://localhost:3000",
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"]
    }
})

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY environment variable not set.")
    raise EnvironmentError("OPENAI_API_KEY environment variable not set.")

OPENAI_SESSION_URL = "https://api.openai.com/v1/realtime/sessions"
OPENAI_API_URL = "https://api.openai.com/v1/realtime"  # May vary based on requirements
MODEL_ID = "gpt-4o-realtime-preview-2024-12-17"
VOICE = "shimmer"  # Or other voices
DEFAULT_INSTRUCTIONS = "You are a Patient Virtual Assistant for Doctor Samir Abbas Hospital in Jeddah..\n\nIn the tools you have the search tool to search through the knowledge base of hospital to find relevant information. Respond to the user in a friendly and helpful manner."

def get_vector_store():
    client = qdrant_client.QdrantClient(
        url=os.getenv("QDRANT_HOST"),
        api_key=os.getenv("QDRANT_API_KEY"),
    )
    embeddings = OpenAIEmbeddings()
    vector_store = Qdrant(
        client=client,
        collection_name=os.getenv("QDRANT_COLLECTION_NAME"),
        embeddings=embeddings,
    )
    return vector_store

vector_store = get_vector_store()



@app.route('/')
def home():
    return "Flask API is running!"

@app.route('/api/rtc-connect', methods=['POST'])
def connect_rtc():
    """
    RTC connection endpoint for handling WebRTC SDP exchange and generating/using ephemeral tokens.
    """
    try:
        # Step 1: Retrieve the client's SDP from the request body
        client_sdp = request.get_data(as_text=True)
        if not client_sdp:
            logger.error("No SDP provided in the request body.")
            return Response("No SDP provided in the request body.", status=400)

        logger.info("Received SDP from client.")

        # Step 2: Generate ephemeral API token
        token_headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json"
        }
        token_payload = {
            "model": MODEL_ID,
            "voice": VOICE
        }

        logger.info("Requesting ephemeral token from OpenAI.")

        token_response = requests.post(OPENAI_SESSION_URL, headers=token_headers, json=token_payload)

        if not token_response.ok:
            logger.error(f"Failed to obtain ephemeral token, status code: {token_response.status_code}, response: {token_response.text}")
            return Response(f"Failed to obtain ephemeral token, status code: {token_response.status_code}", status=500)

        token_data = token_response.json()
        # Adjust the path based on the actual response structure
        # Assuming the ephemeral token is located at `client_secret.value`
        ephemeral_token = token_data.get('client_secret', {}).get('value', '')

        if not ephemeral_token:
            logger.error("Ephemeral token is empty or not found in the response.")
            return Response("Ephemeral token is empty or not found in the response.", status=500)

        logger.info("Ephemeral token obtained successfully.")

        # Step 3: Perform SDP exchange with OpenAI's Realtime API using the ephemeral token
        sdp_headers = {
            "Authorization": f"Bearer {ephemeral_token}",
            "Content-Type": "application/sdp"
        }
        sdp_params = {
            "model": MODEL_ID,
            "instructions": DEFAULT_INSTRUCTIONS,
            "voice": VOICE
        }

        # Build the full URL with query parameters
        sdp_url = requests.Request('POST', OPENAI_API_URL, params=sdp_params).prepare().url

        logger.info(f"Sending SDP to OpenAI Realtime API at {sdp_url}")

        sdp_response = requests.post(sdp_url, headers=sdp_headers, data=client_sdp)

        if not sdp_response.ok:
            logger.error(f"OpenAI API SDP exchange error, status code: {sdp_response.status_code}, response: {sdp_response.text}")
            return Response(f"OpenAI API SDP exchange error, status code: {sdp_response.status_code}", status=500)

        logger.info("SDP exchange with OpenAI completed successfully.")

        # Step 4: Return OpenAI's SDP response to the client with the correct content type
        return Response(
            response=sdp_response.content,
            status=200,
            mimetype='application/sdp'
        )

    except Exception as e:
        logger.exception("An error occurred during the RTC connection process.")
        return Response(f"An error occurred: {str(e)}", status=500)

# Search endpoint
@app.route('/api/search', methods=['POST'])
def search():
    try:
        query = request.json.get('query')
        if not query:
            return jsonify({"error": "No query provided"}), 400

        app.logger.info(f"Searching for: {query}")
        
        # Use existing vector store to search
        results = vector_store.similarity_search_with_score(
            query,
            k=3  # Adjust number of results as needed
        )

        # Format results for the model
        formatted_results = []
        for doc, score in results:
            formatted_results.append({
                "content": doc.page_content,
                "metadata": doc.metadata,
                "relevance_score": float(score)  # Convert score to float for JSON serialization
            })

        app.logger.info(f"Found {len(formatted_results)} results")
        return jsonify({
            "results": formatted_results
        })
    except Exception as e:
        app.logger.error(f"Search error: {str(e)}")
        return jsonify({"error": str(e)}), 500



if __name__ == '__main__':
    # Ensure the server runs on port 8813
    app.run(debug=True, port=8813)
