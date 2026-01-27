"""
Location: python/poi_sdk/stream.py

Summary:
    NDJSON (Newline Delimited JSON) streaming utilities for handling
    server-sent streaming responses.

Usage:
    Used by client.py to parse streaming responses from APIs that
    return NDJSON format (one JSON object per line).

Example:
    from poi_sdk.stream import parse_ndjson_stream

    async with client.stream("POST", url) as response:
        async for item in parse_ndjson_stream(response):
            print(item)
"""

from typing import AsyncIterator, TYPE_CHECKING
import json

if TYPE_CHECKING:
    import httpx


async def parse_ndjson_stream(
    response: "httpx.Response"
) -> AsyncIterator[dict]:
    """
    Parse NDJSON stream from an httpx response.

    NDJSON (Newline Delimited JSON) is a format where each line
    is a valid JSON object. This is commonly used for streaming
    APIs to send incremental updates.

    Args:
        response: An httpx.Response object with an active stream

    Yields:
        Parsed JSON objects from each line

    Raises:
        json.JSONDecodeError: If a line contains invalid JSON

    Example:
        async with client.stream("POST", url) as response:
            async for item in parse_ndjson_stream(response):
                if "error" in item:
                    handle_error(item["error"])
                elif "data" in item:
                    process_data(item["data"])
    """
    async for line in response.aiter_lines():
        line = line.strip()
        if line:
            yield json.loads(line)


async def parse_sse_stream(
    response: "httpx.Response"
) -> AsyncIterator[dict]:
    """
    Parse Server-Sent Events (SSE) stream from an httpx response.

    SSE format uses "data: " prefix for data lines.
    This parser handles the standard SSE format.

    Args:
        response: An httpx.Response object with an active stream

    Yields:
        Parsed JSON objects from data lines

    Example:
        async with client.stream("GET", url) as response:
            async for item in parse_sse_stream(response):
                process_event(item)
    """
    async for line in response.aiter_lines():
        line = line.strip()
        if line.startswith("data: "):
            data = line[6:]  # Remove "data: " prefix
            if data and data != "[DONE]":
                try:
                    yield json.loads(data)
                except json.JSONDecodeError:
                    # Some SSE streams send non-JSON data, skip those
                    continue
