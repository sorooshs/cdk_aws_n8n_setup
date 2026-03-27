import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import { N8nStack } from '../lib/n8n-stack';

describe('N8nStack', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DOMAIN_NAME: 'n8n.example.com',
      N8N_BASIC_AUTH_USER: 'admin',
      N8N_BASIC_AUTH_PASSWORD: 'super-secret-password',
      N8N_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('creates an EC2-backed n8n stack with RDS by default', () => {
    const app = new cdk.App();
    const stack = new N8nStack(app, 'TestN8nStack', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::Instance', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
  });

  test('creates an EC2-backed n8n stack with SQLite when selected', () => {
    process.env = {
      ...process.env,
      N8N_DATABASE_MODE: 'sqlite',
    };

    const app = new cdk.App();
    const stack = new N8nStack(app, 'TestN8nStackSqlite', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::Instance', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });
});
