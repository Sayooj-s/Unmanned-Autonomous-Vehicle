/**
 * Single place to point the dashboard at its backend.
 *
 * Locally (opened via the FastAPI server itself, e.g. http://localhost:8000)
 * this stays empty so requests go to the same origin.
 *
 * Once deployed to Firebase Hosting, the frontend is served from a
 * *.web.app domain but the backend lives on Render — set that URL below
 * so every page's fetch() calls reach it.
 */
window.API_BASE = ""; // e.g. "https://your-app-name.onrender.com" once deployed
