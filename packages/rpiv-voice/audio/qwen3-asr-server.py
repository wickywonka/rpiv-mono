#!/usr/bin/env python3
"""
Minimal HTTP wrapper for mlx-qwen3-asr (sync worker to avoid MLX GPU-stream bug).

Usage:
    python qwen3-asr-server.py --model Qwen/Qwen3-ASR-1.7B --api-key YOUR_KEY

Key points:
- Uses uvicorn with loop="asyncio" and a single worker.
- All MLX inference runs in the main event loop thread (no to_thread).
"""

import argparse
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse
from uvicorn import Config, Server

# Import in main thread so MLX initializes its Metal stream here.
from mlx_qwen3_asr import Session
from mlx_qwen3_asr.convert import quantize_model

app = FastAPI(title="Qwen3-ASR Local Server")

session: Optional[Session] = None
api_keys: list[str] = []


def verify_auth(request: Request) -> bool:
    if not api_keys:
        return True
    auth = (request.headers.get("authorization") or "").strip()
    if not auth.startswith("Bearer "):
        return False
    return auth[7:].strip() in api_keys


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": session.model_id if session else None,
    }


@app.get("/v1/models")
async def list_models(request: Request):
    if not verify_auth(request):
        return JSONResponse(
            status_code=401,
            content={"error": {"message": "Missing or invalid Authorization header"}},
        )
    return {
        "object": "list",
        "data": [
            {
                "id": session.model_id,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "mlx-qwen3-asr",
            }
        ],
    }


@app.post("/v1/audio/transcriptions")
async def transcribe_endpoint(
    request: Request,
    file: UploadFile = File(...),
    model: Optional[str] = None,
):
    if not verify_auth(request):
        return JSONResponse(
            status_code=401,
            content={"error": {"message": "Missing or invalid Authorization header"}},
        )

    if not session:
        return JSONResponse(
            status_code=503,
            content={"error": {"message": "Model not loaded"}},
        )

    audio_bytes = await file.read()

    with tempfile.NamedTemporaryFile(
        suffix=os.path.splitext(file.filename or "audio.wav")[1] or ".wav",
        delete=False,
    ) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        # Run transcription synchronously in the event loop thread
        # (MLX Metal stream lives here). No to_thread / executor.
        result = session.transcribe(tmp_path)
        text = (result.text or "").strip()
        language = getattr(result, "language", None) or ""

        return {
            "text": text,
            "language": language,
        }
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e)}},
        )
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def main():
    global session, api_keys

    parser = argparse.ArgumentParser(description="Qwen3-ASR local HTTP server")
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-1.7B")
    parser.add_argument("--api-key", default="", help="Bearer token (comma-separated allowed)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    api_keys = [k.strip() for k in args.api_key.split(",") if k.strip()] if args.api_key else []

    print(f"Loading model: {args.model} ...", flush=True)
    session = Session(model=args.model)
    print(f"Model loaded: {session.model_id}", flush=True)

    config = Config(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        loop="asyncio",
        # Use a single-threaded event loop; inference runs synchronously here.
        # No worker processes, no extra threads for MLX.
    )
    server = Server(config)
    server.run()


if __name__ == "__main__":
    main()
