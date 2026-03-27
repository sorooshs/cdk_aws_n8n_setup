import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

interface N8nConfig {
  domainName: string;
  basicAuthUser: string;
  basicAuthPassword: string;
  encryptionKey: string;
  databaseMode: 'rds' | 'sqlite';
  instanceType: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function loadConfig(): N8nConfig {
  const databaseMode = (process.env.N8N_DATABASE_MODE || 'rds').toLowerCase() as string;
  if (databaseMode !== 'rds' && databaseMode !== 'sqlite') {
    throw new Error('N8N_DATABASE_MODE must be either "rds" or "sqlite"');
  }

  return {
    domainName: requireEnv('DOMAIN_NAME'),
    basicAuthUser: process.env.N8N_BASIC_AUTH_USER || 'admin',
    basicAuthPassword: requireEnv('N8N_BASIC_AUTH_PASSWORD'),
    encryptionKey: requireEnv('N8N_ENCRYPTION_KEY'),
    databaseMode: databaseMode as N8nConfig['databaseMode'],
    instanceType: process.env.EC2_INSTANCE_TYPE || 't3.micro',
  };
}

export class N8nStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const config = loadConfig();

    const vpc = new ec2.Vpc(this, 'N8nVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    const appSecret = new secretsmanager.Secret(this, 'N8nAppSecret', {
      secretObjectValue: {
        basicAuthUser: cdk.SecretValue.unsafePlainText(config.basicAuthUser),
        basicAuthPassword: cdk.SecretValue.unsafePlainText(config.basicAuthPassword),
        encryptionKey: cdk.SecretValue.unsafePlainText(config.encryptionKey),
      },
    });

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'N8nLoadBalancerSecurityGroup', {
      vpc,
      description: 'Security group for the n8n load balancer',
      allowAllOutbound: true,
    });

    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');
    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');

    const instanceSecurityGroup = new ec2.SecurityGroup(this, 'N8nInstanceSecurityGroup', {
      vpc,
      description: 'Security group for the n8n EC2 instance',
      allowAllOutbound: true,
    });

    instanceSecurityGroup.addIngressRule(
      loadBalancerSecurityGroup,
      ec2.Port.tcp(5678),
      'Allow n8n traffic from the load balancer'
    );

    let dbSecret: secretsmanager.Secret | undefined;
    let dbSecurityGroup: ec2.SecurityGroup | undefined;
    let dbInstance: rds.DatabaseInstance | undefined;

    if (config.databaseMode === 'rds') {
      dbSecret = new secretsmanager.Secret(this, 'N8nDbSecret', {
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'n8n' }),
          generateStringKey: 'password',
          excludePunctuation: true,
        },
      });

      dbSecurityGroup = new ec2.SecurityGroup(this, 'N8nDbSecurityGroup', {
        vpc,
        description: 'Security group for n8n PostgreSQL database',
        allowAllOutbound: true,
      });

      const dbParameterGroup = new rds.ParameterGroup(this, 'N8nDbParameterGroup', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_15,
        }),
        parameters: {
          'rds.force_ssl': '0',
        },
      });

      dbInstance = new rds.DatabaseInstance(this, 'N8nDbInstance', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_15,
        }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroups: [dbSecurityGroup],
        credentials: rds.Credentials.fromSecret(dbSecret),
        databaseName: 'n8n',
        allocatedStorage: 20,
        maxAllocatedStorage: 100,
        backupRetention: cdk.Duration.days(7),
        deletionProtection: false,
        publiclyAccessible: false,
        port: 5432,
        parameterGroup: dbParameterGroup,
      });
    }

    const certificate = new certificatemanager.Certificate(this, 'N8nCertificate', {
      domainName: config.domainName,
      validation: certificatemanager.CertificateValidation.fromDns(),
    });

    const instanceRole = new iam.Role(this, 'N8nInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    instanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );
    appSecret.grantRead(instanceRole);
    dbSecret?.grantRead(instanceRole);

    const userData = ec2.UserData.forLinux();
    const userDataCommands = [
      'set -euxo pipefail',
      'yum update -y',
      'amazon-linux-extras install docker -y',
      'yum install -y jq',
      'systemctl enable docker',
      'systemctl start docker',
      'mkdir -p /opt/n8n/data',
      'chown -R 1000:1000 /opt/n8n/data',
      `APP_SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id '${appSecret.secretArn}' --query SecretString --output text --region '${this.region}')`,
      'cat <<EOF >/opt/n8n/.env',
      `N8N_BASIC_AUTH_ACTIVE=true`,
      `N8N_BASIC_AUTH_USER=$(echo "$APP_SECRET_JSON" | jq -r '.basicAuthUser')`,
      `N8N_BASIC_AUTH_PASSWORD=$(echo "$APP_SECRET_JSON" | jq -r '.basicAuthPassword')`,
      `N8N_HOST=${config.domainName}`,
      'N8N_PORT=5678',
      'N8N_PROTOCOL=https',
      `N8N_EDITOR_BASE_URL=https://${config.domainName}`,
      `WEBHOOK_URL=https://${config.domainName}`,
      `N8N_ENCRYPTION_KEY=$(echo "$APP_SECRET_JSON" | jq -r '.encryptionKey')`,
      'N8N_SECURE_COOKIE=true',
      'EOF',
      'docker pull n8nio/n8n:latest',
      'docker rm -f n8n || true',
      'docker run -d --name n8n --restart unless-stopped -p 5678:5678 --env-file /opt/n8n/.env -v /opt/n8n/data:/home/node/.n8n n8nio/n8n:latest'
    ];

    if (config.databaseMode === 'rds' && dbSecret && dbInstance) {
      userDataCommands.splice(
        9,
        0,
        `DB_SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id '${dbSecret.secretArn}' --query SecretString --output text --region '${this.region}')`
      );
      userDataCommands.splice(
        userDataCommands.indexOf('EOF'),
        0,
        'DB_TYPE=postgresdb',
        `DB_POSTGRESDB_HOST=${dbInstance.dbInstanceEndpointAddress}`,
        'DB_POSTGRESDB_PORT=5432',
        'DB_POSTGRESDB_DATABASE=n8n',
        'DB_POSTGRESDB_USER=n8n',
        `DB_POSTGRESDB_PASSWORD=$(echo "$DB_SECRET_JSON" | jq -r '.password')`,
        'DB_POSTGRESDB_SSL=false'
      );
    } else {
      userDataCommands.splice(
        userDataCommands.indexOf('EOF'),
        0,
        'DB_TYPE=sqlite',
        'DB_SQLITE_DATABASE=/home/node/.n8n/database.sqlite'
      );
    }

    userData.addCommands(...userDataCommands);

    const instance = new ec2.Instance(this, 'N8nInstance', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      role: instanceRole,
      securityGroup: instanceSecurityGroup,
      userData,
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'N8nLoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: loadBalancerSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    const httpListener = loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    httpListener.addAction(
      'HttpRedirect',
      {
        action: elbv2.ListenerAction.redirect({
          port: '443',
          protocol: elbv2.ApplicationProtocol.HTTPS,
          permanent: true,
        }),
      }
    );

    const httpsListener = loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificate.certificateArn)],
    });

    httpsListener.addTargets('N8nInstanceTarget', {
      port: 5678,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new elbv2targets.InstanceTarget(instance, 5678)],
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
      },
    });

    if (dbSecurityGroup) {
      dbSecurityGroup.addIngressRule(
        instanceSecurityGroup,
        ec2.Port.tcp(5432),
        'Allow PostgreSQL access from the n8n instance'
      );
    }

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: loadBalancer.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'ServiceURL', {
      value: `https://${config.domainName}`,
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
    });

    new cdk.CfnOutput(this, 'DatabaseMode', {
      value: config.databaseMode,
    });

    new cdk.CfnOutput(this, 'InstanceType', {
      value: config.instanceType,
    });
  }
}
