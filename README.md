# n8n on AWS EC2

This project deploys n8n (workflow automation tool) on a dedicated AWS EC2 instance with HTTPS support.

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js and npm installed
- AWS CDK installed (`npm install -g aws-cdk`)

## Setup

1. Clone the repository
2. Install dependencies:
   
   ```bash
   npm install
   ```
3. Copy `.env.local.template` to `.env.local` and fill in your values:
   
   ```bash
   cp .env.local.template .env.local
   ```
4. Edit `.env.local` with your configuration:
   - `DOMAIN_NAME`: Your domain name (e.g., example.com)
   - `N8N_BASIC_AUTH_USER`: Username for n8n basic auth
   - `N8N_BASIC_AUTH_PASSWORD`: Password for n8n basic auth
   - `N8N_ENCRYPTION_KEY`: 32-character encryption key for n8n

## Deployment

1. Bootstrap your AWS environment (if not already done):
   
   ```bash
   cdk bootstrap aws://YOUR_ACCOUNT_ID/YOUR_REGION
   ```

2. Deploy the stack:
   
   ```bash
   cdk deploy
   ```

3. After deployment, you'll receive:
   
   - Load Balancer DNS name
   - Service URL
   - EC2 instance ID

4. Configure DNS:
   
   - Create the ACM DNS validation record requested for the certificate
   - Create a CNAME or alias record pointing your domain to the load balancer DNS name
   - Wait for ACM certificate validation before expecting HTTPS to become healthy

## Architecture

The stack creates:

- VPC with public and private subnets
- EC2 instance in a private subnet running Dockerized n8n
- RDS PostgreSQL database
- Application Load Balancer with HTTPS support
- ACM Certificate for your domain
- n8n instance with basic authentication

## Security

- Database is in private subnets
- n8n runs on a private EC2 instance behind the load balancer
- HTTPS enforced with automatic HTTP to HTTPS redirect
- Basic authentication enabled
- Secure cookies enabled
- Application and database credentials stored in AWS Secrets Manager
- EC2 access is intended through AWS Systems Manager rather than SSH

## Cleanup

To remove all resources:

```bash
cdk destroy
```
