import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as athena from "aws-cdk-lib/aws-athena";
import * as glue from "aws-cdk-lib/aws-glue";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ウェブサイトホスティング用のS3バケット（OAC用にプライベート設定）
    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      bucketName: `website-hosting-${this.account}-${
        cdk.Stack.of(this).region
      }`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // WAFログ保存用のS3バケット
    const wafLogBucket = new s3.Bucket(this, "WafLogBucket", {
      bucketName: `waf-logs-${this.account}-${cdk.Stack.of(this).region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Athenaクエリ結果保存用のS3バケット
    const athenaResultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      bucketName: `athena-results-${this.account}-${cdk.Stack.of(this).region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // CloudFront用のWAF Web ACL（us-east-1リージョンでのみ作成）
    const webAcl = new wafv2.CfnWebACL(this, "WebACL", {
      scope: "CLOUDFRONT",
      defaultAction: {
        allow: {},
      },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          overrideAction: {
            none: {},
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "CommonRuleSetMetric",
          },
        },
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          priority: 2,
          overrideAction: {
            none: {},
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "KnownBadInputsRuleSetMetric",
          },
        },
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "webACL",
      },
    });

    // Firehose用のIAMロールを作成
    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
    });

    // S3バケットへの書き込み権限
    wafLogBucket.grantWrite(firehoseRole);

    // Firehoseデリバリーストリームを作成
    const wafLogsDeliveryStream = new firehose.CfnDeliveryStream(
      this,
      "WafLogsDeliveryStream",
      {
        deliveryStreamType: "DirectPut",
        deliveryStreamName: "aws-waf-logs-delivery-stream",
        s3DestinationConfiguration: {
          bucketArn: wafLogBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          bufferingHints: {
            intervalInSeconds: 60,
            sizeInMBs: 1,
          },
          prefix: "waf-logs/",
          errorOutputPrefix: "waf-logs-errors/",
        },
      }
    );

    // WAFログ設定
    const wafLogConfig = new wafv2.CfnLoggingConfiguration(
      this,
      "WafLoggingConfig",
      {
        resourceArn: webAcl.attrArn,
        logDestinationConfigs: [wafLogsDeliveryStream.attrArn],
      }
    );

    wafLogConfig.node.addDependency(webAcl);
    wafLogConfig.node.addDependency(wafLogBucket);

    const oac = new cloudfront.S3OriginAccessControl(this, "OAC", {
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(
      websiteBucket,
      {
        originAccessControl: oac,
      }
    );

    // CloudFrontディストリビューション
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      webAclId: webAcl.attrArn,
    });

    // ウェブサイトコンテンツのS3デプロイメント
    new s3deploy.BucketDeployment(this, "DeployWebsiteContents", {
      sources: [s3deploy.Source.asset("./website")],
      destinationBucket: websiteBucket,
      distribution: distribution,
      distributionPaths: ["/*"],
    });

    // Athena用のIAMロール
    const athenaRole = new iam.Role(this, "AthenaRole", {
      assumedBy: new iam.ServicePrincipal("athena.amazonaws.com"),
    });

    // Athenaの権限を付与
    athenaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonAthenaFullAccess")
    );

    // Athenaに対してS3バケットへのアクセス権限を付与
    athenaResultsBucket.grantReadWrite(athenaRole);
    wafLogBucket.grantRead(athenaRole);

    // Glueデータベース（Athena用）
    const glueDatabase = new glue.CfnDatabase(this, "WafLogsDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: "waf_logs_database",
        description: "Database for WAF logs analysis",
      },
    });

    // WAFログ用のGlueテーブル（JSON形式）
    new glue.CfnTable(this, "WafLogsTable", {
      catalogId: this.account,
      databaseName: glueDatabase.ref,
      tableInput: {
        name: "waf_logs",
        description: "Table for WAF logs stored in S3",
        tableType: "EXTERNAL_TABLE",
        parameters: {
          classification: "json",
          typeOfData: "file",
          "projection.enabled": "true",
          "projection.year.type": "integer",
          "projection.year.range": "2024,2030",
          "projection.month.type": "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          "projection.day.type": "integer",
          "projection.day.range": "1,31",
          "projection.day.digits": "2",
          "projection.hour.type": "integer",
          "projection.hour.range": "0,23",
          "projection.hour.digits": "2",
          "storage.location.template": `s3://${wafLogBucket.bucketName}/waf-logs/\${year}/\${month}/\${day}/\${hour}`,
        },
        storageDescriptor: {
          columns: [
            { name: "timestamp", type: "bigint" },
            { name: "formatversion", type: "int" },
            { name: "webaclid", type: "string" },
            { name: "terminatingruleid", type: "string" },
            { name: "terminatingruletype", type: "string" },
            { name: "action", type: "string" },
            {
              name: "terminatingrulematchdetails",
              type: "array<struct<conditiontype:string,location:string,matcheddata:array<string>>>",
            },
            { name: "httpsourcename", type: "string" },
            { name: "httpsourceid", type: "string" },
            {
              name: "rulegrouplist",
              type: "array<struct<rulegroupid:string,terminatingrule:struct<ruleid:string,action:string,rulematchdetails:string>,nonterminatingmatchingrules:array<struct<ruleid:string,action:string,rulematchdetails:string>>,excludedrules:string>>",
            },
            {
              name: "ratebasedrulelist",
              type: "array<struct<ratebasedruleid:string,limitkey:string,maxrateallowed:int>>",
            },
            {
              name: "nonterminatingmatchingrules",
              type: "array<struct<ruleid:string,action:string>>",
            },
            { name: "requestheadersinserted", type: "string" },
            { name: "responsecodesent", type: "string" },
            {
              name: "httprequest",
              type: "struct<clientip:string,country:string,headers:array<struct<name:string,value:string>>,uri:string,args:string,httpversion:string,httpmethod:string,requestid:string>",
            },
            { name: "labels", type: "array<struct<name:string>>" },
          ],
          location: `s3://${wafLogBucket.bucketName}/waf-logs/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat:
            "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: {
              "ignore.malformed.json": "true",
            },
          },
        },
        partitionKeys: [
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
          { name: "hour", type: "string" },
        ],
      },
    });

    // Athenaワークグループ
    const athenaWorkgroup = new athena.CfnWorkGroup(this, "WafLogsWorkGroup", {
      name: "waf-logs-workgroup",
      description: "Workgroup for WAF logs analysis",
      state: "ENABLED",
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/query-results/`,
        },
        enforceWorkGroupConfiguration: true,
      },
    });

    // Athenaクエリ実行用のLambda関数
    const athenaQueryFunction = new lambdaNodejs.NodejsFunction(
      this,
      "AthenaQueryFunction",
      {
        entry: "./lambda/athena-query.ts",
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        functionName: "athena-query-function",
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        description:
          "Execute custom Athena queries against WAF logs stored in S3 and return results",
        environment: {
          ATHENA_DATABASE: glueDatabase.ref,
          ATHENA_WORKGROUP: athenaWorkgroup.name!,
          ATHENA_RESULTS_BUCKET: athenaResultsBucket.bucketName,
        },
      }
    );

    // Lambda関数にAthenaとS3の権限を付与
    athenaQueryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "athena:StartQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "athena:ListQueryExecutions",
          "athena:StopQueryExecution",
        ],
        resources: ["*"],
      })
    );

    athenaQueryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject",
          "s3:DeleteObject",
        ],
        resources: [
          athenaResultsBucket.bucketArn,
          `${athenaResultsBucket.bucketArn}/*`,
          wafLogBucket.bucketArn,
          `${wafLogBucket.bucketArn}/*`,
        ],
      })
    );

    athenaQueryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions"],
        resources: ["*"],
      })
    );

    // 出力値
    new cdk.CfnOutput(this, "WebsiteBucketName", {
      value: websiteBucket.bucketName,
      description: "Name of the S3 bucket for website hosting",
    });

    new cdk.CfnOutput(this, "WafLogBucketName", {
      value: wafLogBucket.bucketName,
      description: "Name of the S3 bucket for WAF logs",
    });

    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "Domain name of the CloudFront distribution",
    });

    new cdk.CfnOutput(this, "DistributionUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "URL of the CloudFront distribution",
    });

    new cdk.CfnOutput(this, "WebACLArn", {
      value: webAcl.attrArn,
      description: "ARN of the WAF Web ACL",
    });

    new cdk.CfnOutput(this, "AthenaResultsBucketName", {
      value: athenaResultsBucket.bucketName,
      description: "Name of the S3 bucket for Athena query results",
    });

    new cdk.CfnOutput(this, "GlueDatabaseName", {
      value: glueDatabase.ref,
      description: "Name of the Glue database for WAF logs",
    });

    new cdk.CfnOutput(this, "AthenaWorkgroupName", {
      value: athenaWorkgroup.name!,
      description: "Name of the Athena workgroup for WAF logs analysis",
    });

    new cdk.CfnOutput(this, "SampleAthenaQuery", {
      value: `SELECT 
  from_unixtime(timestamp/1000) as request_time,
  httprequest.clientip as client_ip,
  httprequest.country as country,
  httprequest.httpmethod as method,
  httprequest.uri as uri,
  action,
  terminatingruleid
FROM waf_logs_database.waf_logs 
WHERE year='2025' AND month='01'
LIMIT 100;`,
      description: "Sample Athena query to analyze WAF logs",
    });

    new cdk.CfnOutput(this, "AthenaQueryFunctionArn", {
      value: athenaQueryFunction.functionArn,
      description: "ARN of the Athena query Lambda function",
    });
  }
}
