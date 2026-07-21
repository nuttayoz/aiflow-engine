import os

import boto3

bucket = os.environ["AIFLOW_S3_BUCKET"]
client = boto3.client("s3", endpoint_url=os.environ["AIFLOW_S3_ENDPOINT"])

if bucket not in {item["Name"] for item in client.list_buckets()["Buckets"]}:
    client.create_bucket(Bucket=bucket)

client.put_bucket_versioning(
    Bucket=bucket,
    VersioningConfiguration={"Status": "Enabled"},
)

client.put_bucket_cors(
    Bucket=bucket,
    CORSConfiguration={
        "CORSRules": [
            {
                "AllowedHeaders": [
                    "content-length",
                    "content-type",
                    "if-none-match",
                    "x-amz-checksum-sha256",
                    "x-amz-meta-aiflow-checksum-sha256",
                    "x-amz-meta-aiflow-checksum-type",
                    "x-amz-server-side-encryption",
                ],
                "AllowedMethods": ["PUT"],
                "AllowedOrigins": ["http://localhost:4173"],
                "ExposeHeaders": ["ETag", "x-amz-checksum-sha256"],
                "MaxAgeSeconds": 300,
            }
        ]
    },
)
