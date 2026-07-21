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
