# Production deployment on AWS (target architecture)

> Not deployed in this build. The code paths for RDS, S3 and Cognito are
> implemented; this guide describes how to stand them up.

## Components

| Service | Configuration |
|---|---|
| **Amazon ECR** | Repository `granttrail-ai`; push the image built from `/Dockerfile` |
| **Amazon ECS (Fargate)** | Service with ≥ 2 tasks across AZs in private subnets; task definition like `infra/ecs-task-definition.example.json`; read-only root filesystem |
| **Application Load Balancer** | HTTPS listener (ACM certificate), HTTP→HTTPS redirect, health check `GET /api/health` |
| **AWS WAF** | AWS managed rule groups + rate-based rule on the ALB/CloudFront |
| **Amazon RDS for PostgreSQL 16** | Multi-AZ, storage encryption (KMS), `rds.force_ssl=1`, automated backups + PITR, private subnets, SG allows only the ECS task SG on 5432 |
| **Amazon S3** | Bucket `granttrail-agreements-<env>`: Block Public Access on, SSE-KMS default encryption, bucket policy denying non-TLS and unencrypted puts, versioning, lifecycle to Glacier after retention period |
| **Amazon Cognito** | User pool with MFA required, password policy, advanced security; app client (no secret) for the SPA with PKCE; groups `grants_specialist`, `finance_director` |
| **Secrets Manager** | `granttrail/database-url`, `granttrail/anthropic-api-key` injected as ECS secrets |
| **CloudWatch** | Log group `/ecs/granttrail-ai`, alarms on 5xx rate, task health, RDS CPU/storage |

## IAM (task role)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::granttrail-agreements-prod/agreements/*" },
    { "Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"], "Resource": "arn:aws:kms:REGION:ACCOUNT_ID:key/KEY_ID" }
  ]
}
```

The execution role additionally needs `secretsmanager:GetSecretValue` on the two
secrets and the standard ECR/CloudWatch Logs permissions.

## Environment (production)

```
NODE_ENV=production
AUTH_MODE=cognito            # AUTH_MODE=dev is refused in production
COGNITO_USER_POOL_ID=...
COGNITO_CLIENT_ID=...
DATABASE_URL=<secret>
DATABASE_SSL=true
NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem   # bake the RDS CA bundle into the image
STORAGE_DRIVER=s3
S3_BUCKET=granttrail-agreements-prod
S3_KMS_KEY_ID=arn:aws:kms:...
AI_MODE=claude
ANTHROPIC_API_KEY=<secret>
AUTO_SEED=false
```

## Release steps

1. `docker build -t granttrail-ai .` and push to ECR.
2. Migrations run automatically on container start (idempotent, checksum-guarded).
   For stricter control, run `node server/dist/db/cli.js migrate` as a one-off ECS task first.
3. Update the ECS service to the new task definition revision (rolling deployment).
4. Verify `/api/health` reports `ai: claude`, `database: postgres`, `storage: s3`, `auth: cognito`.

## Data retention

Federal award records generally must be retained for three years after final
expenditure reporting (2 CFR 200.334). Configure S3 lifecycle and RDS backup
retention to meet Riverbend's records policy.
