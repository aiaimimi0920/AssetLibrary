"""Copy quiesced PC2 MinIO objects to private R2 without overwriting bytes.

Run through a loopback SSH tunnel with process-scoped credentials. This tool
does not stop services, delete objects, change SQL facts, or switch readers.
"""

import argparse
import contextlib
import hashlib
import json
import logging
import os
import tempfile
from urllib.parse import urlparse

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

# Host logging configuration must not expose signed requests or credentials.
logging.disable(logging.CRITICAL)

MAX_OBJECTS = 1000
MAX_BYTES = 1024 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


def client(prefix):
    endpoint = os.environ[prefix + "_ENDPOINT"]
    parsed = urlparse(endpoint)
    if prefix == "SOURCE":
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise ValueError("source must be a loopback SSH tunnel")
    elif parsed.scheme != "https" or not parsed.hostname.endswith(".r2.cloudflarestorage.com"):
        raise ValueError("destination must be an HTTPS R2 endpoint")
    store = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="us-east-1" if prefix == "SOURCE" else "auto",
        aws_access_key_id=os.environ[prefix + "_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ[prefix + "_SECRET_ACCESS_KEY"],
        config=Config(
            signature_version="s3v4",
            connect_timeout=15,
            read_timeout=60,
            retries={"max_attempts": 3},
            s3={"addressing_style": "path"},
        ),
    )
    if prefix == "TARGET":
        # Older SDK models omit IfNoneMatch, but R2 honors the signed header.
        store.meta.events.register("before-sign.s3.PutObject", require_create_only)
    return store


def require_create_only(request, **_kwargs):
    request.headers["If-None-Match"] = "*"


def read_hash(store, bucket, key, expected_size, output=None):
    response = store.get_object(Bucket=bucket, Key=key)
    body = response["Body"]
    digest = hashlib.sha256()
    size = 0
    try:
        for chunk in body.iter_chunks(CHUNK_BYTES):
            size += len(chunk)
            if size > expected_size or size > MAX_BYTES:
                raise ValueError("object exceeds its declared size")
            digest.update(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        body.close()
    if size != expected_size:
        raise ValueError("object length changed")
    return digest.hexdigest()


def copy_one(source, target, bucket, destination, item, execute):
    key, size = item["Key"], item["Size"]
    if size > MAX_BYTES:
        raise ValueError("object exceeds the bounded migration limit")
    with tempfile.TemporaryFile() as archive:
        raw_sha256 = read_hash(source, bucket, key, size, archive)
        exists = True
        try:
            head = target.head_object(Bucket=destination, Key=key)
        except ClientError as error:
            if str(error.response["Error"]["Code"]) not in ("404", "NoSuchKey"):
                raise
            exists = False
        if exists:
            if head["ContentLength"] != size:
                raise ValueError("destination length mismatch; refusing overwrite")
            if read_hash(target, destination, key, size) != raw_sha256:
                raise ValueError("destination digest mismatch; refusing overwrite")
        elif execute:
            archive.seek(0)
            source_head = source.head_object(Bucket=bucket, Key=key)
            if source_head["ContentLength"] != size or source_head["ETag"] != item["ETag"]:
                raise ValueError("source changed; restore quiescence before retry")
            target.put_object(
                Bucket=destination,
                Key=key,
                Body=archive,
                ContentLength=size,
                ContentType=source_head.get("ContentType", "application/octet-stream"),
                Metadata=source_head.get("Metadata", {}),
            )
            if read_hash(target, destination, key, size) != raw_sha256:
                raise ValueError("copied object digest mismatch")
        return {
            "bucket": bucket,
            "destination": destination,
            "key_sha256": hashlib.sha256(key.encode("utf-8")).hexdigest(),
            "bytes": size,
            "raw_sha256": raw_sha256,
            "outcome": "verified-existing" if exists else "copied-verified" if execute else "copy-required",
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--copy", action="store_true", help="copy absent objects after quiescence")
    args = parser.parse_args()
    source, target = client("SOURCE"), client("TARGET")
    results = []
    try:
        for suffix in ("quarantine", "published"):
            bucket = "assetlibrary-" + suffix
            destination = "assetlibrary-pc2-" + suffix
            uploads = source.list_multipart_uploads(Bucket=bucket, MaxUploads=1)
            if uploads.get("Uploads"):
                raise ValueError("active source multipart upload; migration refused")
            for page in source.get_paginator("list_objects_v2").paginate(Bucket=bucket):
                for item in page.get("Contents", []):
                    if len(results) >= MAX_OBJECTS:
                        raise ValueError("object count exceeds bounded migration limit")
                    results.append(copy_one(source, target, bucket, destination, item, args.copy))
        return {"mode": "copy" if args.copy else "verify", "objects": results}
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    try:
        # Provider debug hooks may print request bodies directly, outside logging.
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink):
            result = main()
        print(json.dumps(result))
    except Exception as error:
        # Provider exceptions can contain presigned URLs; expose only the class.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        raise SystemExit(1) from None
