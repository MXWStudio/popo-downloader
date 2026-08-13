import argparse
import hashlib
import json
import os
from pathlib import Path

from qcloud_cos import CosConfig, CosS3Client, CosServiceError


def main() -> None:
    parser = argparse.ArgumentParser(description="Upload one verified POPO release object to Tencent COS.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--content-type", required=True)
    parser.add_argument("--cache-control", required=True)
    parser.add_argument("--sha256", default="")
    parser.add_argument("--allow-overwrite", action="store_true")
    parser.add_argument("--bucket", default="popo-updates-1461466196")
    parser.add_argument("--region", default="ap-guangzhou")
    args = parser.parse_args()

    secret_id = os.environ.get("TENCENT_COS_SECRET_ID", "").strip()
    secret_key = os.environ.get("TENCENT_COS_SECRET_KEY", "").strip()
    token = os.environ.get("TENCENT_COS_SESSION_TOKEN", "").strip() or None
    if not secret_id or not secret_key:
        raise RuntimeError("Tencent COS release credentials are not configured.")

    source = Path(args.file).resolve(strict=True)
    actual_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    expected_sha256 = args.sha256.strip().lower()
    if expected_sha256 and actual_sha256 != expected_sha256:
        raise RuntimeError("The local object SHA-256 does not match the expected release digest.")
    config = CosConfig(
        Region=args.region,
        SecretId=secret_id,
        SecretKey=secret_key,
        Token=token,
        Scheme="https",
    )
    client = CosS3Client(config)
    metadata = {"x-cos-meta-sha256": actual_sha256}
    if not args.allow_overwrite:
        metadata["x-cos-forbid-overwrite"] = "true"
    headers = {
        "ACL": "public-read",
        "ContentType": args.content_type,
        "CacheControl": args.cache_control,
        # The pinned SDK forwards complete x-cos-* header names through Metadata.
        "Metadata": metadata,
    }

    try:
        with source.open("rb") as stream:
            response = client.put_object(
                Bucket=args.bucket,
                Key=args.key,
                Body=stream,
                EnableMD5=True,
                **headers,
            )
        reused = False
    except CosServiceError as error:
        if args.allow_overwrite or error.get_status_code() not in (409, 412):
            raise
        existing = client.head_object(Bucket=args.bucket, Key=args.key)
        existing_size = int(existing.get("Content-Length", "-1"))
        existing_sha256 = existing.get("x-cos-meta-sha256", "").lower()
        if existing_size == source.stat().st_size and not existing_sha256:
            remote = client.get_object(Bucket=args.bucket, Key=args.key)
            digest = hashlib.sha256()
            for chunk in remote["Body"].get_stream(chunk_size=1024 * 1024):
                digest.update(chunk)
            existing_sha256 = digest.hexdigest()
        if existing_size != source.stat().st_size or existing_sha256 != actual_sha256:
            raise RuntimeError("A different immutable object already exists at the release key.") from error
        response = existing
        reused = True

    print(json.dumps({
        "ok": True,
        "bucket": args.bucket,
        "key": args.key,
        "size": source.stat().st_size,
        "sha256": actual_sha256,
        "reused": reused,
        "etag": response.get("ETag"),
        "requestId": response.get("x-cos-request-id"),
    }))


if __name__ == "__main__":
    main()
