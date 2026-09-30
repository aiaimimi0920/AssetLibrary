"""Safety gates for the copy-only PC2 migration utility."""

import hashlib
import io
import os
import unittest
from unittest.mock import patch

from botocore.exceptions import ClientError

import copy_objects


class Body(io.BytesIO):
    def iter_chunks(self, size):
        while chunk := self.read(size):
            yield chunk


class Store:
    def __init__(self, body=None):
        self.body = body
        self.writes = 0

    def get_object(self, **_kwargs):
        return {"Body": Body(self.body)}

    def head_object(self, **_kwargs):
        if self.body is None:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": len(self.body), "ETag": "etag"}

    def put_object(self, **kwargs):
        self.writes += 1
        self.body = kwargs["Body"].read()


class MigrationSafety(unittest.TestCase):
    def copy(self, source, target, execute=True):
        return copy_objects.copy_one(
            source, target, "source", "target",
            {"Key": "object", "Size": len(source.body), "ETag": "etag"}, execute,
        )

    def test_conflicting_same_length_bytes_are_never_overwritten(self):
        target = Store(b"other")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.copy(Store(b"input"), target)
        self.assertEqual(target.body, b"other")
        self.assertEqual(target.writes, 0)

    def test_verified_retry_and_dry_run_do_not_write(self):
        for target in (Store(b"input"), Store()):
            result = self.copy(Store(b"input"), target, execute=False)
            self.assertIn(result["outcome"], ("verified-existing", "copy-required"))
            self.assertEqual(target.writes, 0)

    def test_copy_is_rehashed_and_retry_is_idempotent(self):
        target = Store()
        result = self.copy(Store(b"input"), target)
        self.assertEqual(result["raw_sha256"], hashlib.sha256(b"input").hexdigest())
        self.assertEqual(result["outcome"], "copied-verified")
        self.assertEqual(self.copy(Store(b"input"), target)["outcome"], "verified-existing")
        self.assertEqual(target.writes, 1)

    def test_conditional_header_is_in_the_actual_signed_request(self):
        class Captured(Exception):
            pass

        requests = []

        def intercept(request, **_kwargs):
            requests.append(request)
            raise Captured()

        environment = {
            "TARGET_ENDPOINT": "https://unit.r2.cloudflarestorage.com",
            "TARGET_ACCESS_KEY_ID": "unit-test-access",
            "TARGET_SECRET_ACCESS_KEY": "unit-test-secret",
        }
        with patch.dict(os.environ, environment):
            target = copy_objects.client("TARGET")
        try:
            target.meta.events.register("before-send.s3.PutObject", intercept)
            with self.assertRaises(Captured):
                target.put_object(Bucket="target", Key="object", Body=b"input")
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].headers["If-None-Match"], b"*")
            self.assertIn(b"if-none-match", requests[0].headers["Authorization"])
        finally:
            target.close()


if __name__ == "__main__":
    unittest.main()
