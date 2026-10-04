# Deploying GrantTrail AI to AWS Elastic Beanstalk

The public classroom deployment mirrors the first course app (Express serving a
production React build on `process.env.PORT`, deployed to Elastic Beanstalk) and
adds GitHub Actions auto-deploy.

## How it runs on Elastic Beanstalk

| Piece | Setting |
|---|---|
| Platform | Node.js 22 on Amazon Linux 2023, **single instance**, **t3.micro**, no load balancer |
| Start command | `Procfile` → `node server/dist/index.js` (compiled Express server, not a dev server) |
| Port | EB sets `PORT=8080`; nginx on port 80 proxies to it |
| Frontend | `npm run build` → `client/dist`, served by Express from the same origin |
| Database | Embedded PostgreSQL (PGlite) in `/var/app/granttrail-data` — survives deploys, lost if the instance is replaced |
| Uploads | Same folder; nginx body limit raised to 12 MB (`.platform/nginx/conf.d`) |
| Settings | `.ebextensions/01-environment.config` (no secrets) |

`PUBLIC_DEMO=true` is an explicit opt-in that allows the demo-user switcher in
production **and forces simulated extraction**, so the Claude API is never called
and no key is configured on AWS. `FORCE_HTTPS=false` because a single instance
serves plain HTTP. For a real deployment use Cognito, RDS, S3 and HTTPS
(see `docs/aws-deployment.md`).

## Auto-deploy pipeline (`.github/workflows/deploy.yml`)

`push to main` → `npm ci` → type-check → **tests (deploy stops if any fail)** →
`npm run build` → `scripts/build-eb-bundle.sh` (built code + exact production
dependencies) → upload to the EB S3 bucket → new application version →
`update-environment` → wait for Ready → check `/api/health` on the live URL.

No AWS keys are stored in GitHub: the workflow uses GitHub OIDC to assume the
`granttrail-github-deploy` IAM role, which trusts only the `main` branch of this
repository and has the `AdministratorAccess-AWSElasticBeanstalk` managed policy.

## Cost note

Each t3.micro instance runs 24/7 (~730 hours/month). Two environments exceed the
750 free-tier hours. After grading, terminate the environment you don't need:
`aws elasticbeanstalk terminate-environment --environment-name GrantTrail-AI-env`.
