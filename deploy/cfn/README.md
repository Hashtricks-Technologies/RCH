# `deploy/cfn` — RCH environment resources

`rch-env.yaml` codifies everything the account owner created by hand with the AWS CLI: the
Postgres instance, its parameter group, subnet group and security group, the two ECR
repositories and their lifecycle policies, the GitHub Actions OIDC provider and deploy role, a
per-environment Secrets Manager secret, an ACM certificate and its CAA record, an optional ALB
access-log bucket, and the uptime health check with the SNS topic it pages. It does **not**
cover the EKS cluster, its node groups or its add-ons (`deploy/eksctl/cluster.yaml` — that file
says so at the top, in both directions), the load balancer controller, subnet tags or any
Kubernetes object.

One template, one stack per environment (`dev`, `staging`, `prod` — only `dev` exists today).
Every `aws cloudformation` call below needs `--capabilities CAPABILITY_NAMED_IAM` because the
template names an `AWS::IAM::Role`.

## Why the resources are split "shared" vs "per-environment"

A handful of the CLI-created resources are singletons AWS will not let a second stack recreate:
the DB subnet group (`rch`) is one VPC-wide group serving every environment's database, both ECR
repositories (`rch-api`, `rch-ui`) are one registry for every environment's images, and the
GitHub Actions OIDC provider is account-global outright — the role `rch-github-deploy`'s own
trust policy already admits every environment in one document, so it is shared too.

The template's `IsDev` condition (`Env == "dev"`) gates all four: only a stack with `Env=dev`
declares them. A `staging` or `prod` stack skips them and instead reads their identifiers back
with `Fn::ImportValue` from four fixed export names the `dev` stack publishes (`rch-shared-db-
subnet-group-name`, `rch-shared-ecr-api-uri`, `rch-shared-ecr-ui-uri`,
`rch-shared-github-deploy-role-arn`). **This means the `dev` stack must exist before any
`staging` or `prod` stack is created** — the import fails otherwise, plainly, with
"No export named ... found."

**The DB security group used to be the fifth, and is not any more.** `rch-rds` admits 5432 from
the whole VPC CIDR, so every environment importing it put its database behind a rule that admits
anything anyone ever launches into the default VPC. `dev` keeps that group and that rule — dev is
where somebody port-forwards from a box in the VPC — behind an explicit `DbIngressCidr`
parameter that says so. `staging` and `prod` each build their own `rch-rds-<env>` group admitting
**only** `NodeSecurityGroupId`, the EKS node group, which is the only thing that ever connects.
The `rch-shared-db-security-group-id` export is gone with it; nothing imported it, because no
stack but `dev` has ever existed.

Everything else — the DB instance and its parameter group, its Secrets Manager secret, the ACM
certificate, the CAA record, the uptime health check — is genuinely per-environment; every stack
creates its own, named from the `Env` parameter (`rch-${Env}`, `rch/${Env}`, the environment's
own `HostName`).

## The database settings, and which ones need a reboot

`DbParameterGroup` (family `postgres17`, one per environment) carries three settings the
instance did not have:

| Parameter | Value | Why |
|---|---|---|
| `rds.force_ssl` | `1` | The API already connects with `DATABASE_SSL=true`; this makes a plaintext connection impossible rather than merely unused. **Static** — see below. |
| `log_min_duration_statement` | `1000` ms | The snapshot read is the heaviest query in the system and comes in well under a second, so this logs regressions, not traffic. Dynamic. |
| `idle_in_transaction_session_timeout` | `60000` ms | A transaction left open holds the row locks the whole write path queues behind. A minute is far longer than any write here takes. Dynamic. |

### Run this stack update off-hours: it may reboot the database

**Attaching a parameter group that contains a static parameter is "Some interruptions" in the
CloudFormation reference, not "No interruption".** `rds.force_ssl` is static, and
`DBParameterGroupName` is therefore an update CloudFormation may satisfy by **rebooting the
instance for you**, during the update, whenever it feels like it — not at a time you chose.
Schedule the first `aws cloudformation deploy` after this change for the small hours, the same
way a maintenance window is scheduled, and do not run it during a service.

Of everything this template newly sets on `Database`:

| Property | Update behaviour | What that means here |
|---|---|---|
| `DBParameterGroupName` | **Some interruptions** | Attaching a group with a static parameter in it can reboot the instance as part of the update. |
| `AutoMinorVersionUpgrade` | **Some interruptions** | Documented as such; in practice benign, but it is on the same update. |
| `PreferredMaintenanceWindow` | **Some interruptions** | Changing the window can trigger a reboot if there is pending maintenance to apply. |
| `MaxAllocatedStorage` | No interruption | |
| `EnableCloudwatchLogsExports` | No interruption | |
| `EnablePerformanceInsights` / `PerformanceInsightsRetentionPeriod` | No interruption | |
| `MonitoringInterval` / `MonitoringRoleArn` | No interruption | |
| `PreferredBackupWindow` | No interruption | |

None of them **replaces** the instance — nothing here is destructive — but three of them can
bounce it, so treat the whole update as an outage window.

**And a reboot may still be needed afterwards.** A static parameter attached by an update that
did *not* reboot sits `pending-reboot`, and TLS is not actually enforced until it does. Check,
and finish the job by hand if the update did not:

```bash
aws rds describe-db-parameters --region ap-south-1 \
  --db-parameter-group-name <the DbParameterGroupName output> \
  --query "Parameters[?ParameterName=='rds.force_ssl']"
aws rds describe-db-instances --region ap-south-1 --db-instance-identifier rch-dev \
  --query 'DBInstances[0].DBParameterGroups'          # expect pending-reboot, then in-sync
aws rds reboot-db-instance --region ap-south-1 --db-instance-identifier rch-dev
```

Reboot in the maintenance window, not during a service.

### The rest of what the instance now carries

`AutoMinorVersionUpgrade: false` (the template pins `17.9`, so letting AWS move it reads as drift
on the next change set), `EnableCloudwatchLogsExports: [postgresql]`, Enhanced Monitoring at
`MonitoringIntervalSeconds` with a role this stack creates, and backup/maintenance windows in the
small hours IST (`20:30-21:30` UTC = 02:00-03:00 IST; `sun:22:00-sun:23:00` UTC = Monday
03:30-04:30 IST).

**Performance Insights is on in every environment**, at the free 7-day retention. An earlier
draft of this file said dev and staging left it off because AWS does not offer it on the smallest
burstable classes. That was simply wrong, and checking took one command:

```bash
aws rds describe-orderable-db-instance-options --engine postgres --engine-version 17.9 \
  --region ap-south-1 \
  --query "OrderableDBInstanceOptions[?contains(DBInstanceClass,'t4g')].[DBInstanceClass,SupportsPerformanceInsights]"
# db.t4g.micro true, db.t4g.small true, db.t4g.medium true — all of them
```

`db.t4g.micro`, `db.t4g.small` and `db.t4g.medium` all support it, and the 7-day tier is free on
all three, so there was neither a technical nor a cost reason to leave dev and staging blind. The
`EnablePerformanceInsights` parameter stays so an environment can be turned off deliberately.

`DbMaxAllocatedStorage` is `0` for `dev` — `0` omits the property entirely, which is what an
instance that never had storage autoscaling already looks like, so the imported stack's verify
change set stays empty — and `40` / `100` for staging and prod.

## ECR does not keep every image any more

Both repositories carry a lifecycle policy: untagged images expire after 7 days (orphaned layers
of an overwritten manifest, worth nothing after a week), and only the 30 most recent tagged
images are kept. Thirty is far more history than `helm rollback` or `deploy.yml`'s release tag
can reach back to. Before this, nothing ever deleted an image and every push of every branch
since the first deploy was still being billed for.

## ALB access logs, and why the chart cannot turn them on by itself

`AlbLogsBucketName` is empty by default and creates nothing. Give it a real (globally unique)
name and the stack creates the bucket — public access blocked, `BucketOwnerEnforced`, SSE-S3, no
versioning, a 90-day expiry — plus the policy that lets Elastic Load Balancing write into it, and
publishes the name as the `AlbLogsBucket` output.

`deploy/chart/rch/values-prod.yaml` may set `access_logs.s3.enabled=true` **only once that bucket
exists with that policy.** An ALB told to log into a bucket it cannot write to reports nothing
wrong and simply writes nothing — the ingress is healthy, the controller is happy, and the logs
are not there. That is why the annotation was taken back out of the chart until this parameter is
filled in.

**Two principals, and why both.** AWS's current documented policy grants the service principal
`logdelivery.elasticloadbalancing.amazonaws.com` with an `aws:SourceAccount` condition; the older
shape, still documented and still supported for regions that existed before August 2022 —
`ap-south-1` is one — grants the per-region ELB account, `718504428378` here, via
`ElbLogDeliveryAccountId`. The policy grants **both**. If only one were kept it should be the
service principal, which is where AWS is going; both are there because the failure mode is silent
— an ALB that cannot write its access logs reports nothing wrong and simply writes none — and
because both are AWS-owned identities delivering the same objects to the same place. If this
stack ever moves region, change the account id as well as the region.

**Both statements are scoped to `AWSLogs/<this account>/*`**, AWS's documented resource path, not
to the whole bucket. That means **the ingress must not set `access_logs.s3.prefix`**: a prefix
moves every object to `<prefix>/AWSLogs/...`, which this policy does not permit, and the ALB would
then write nothing — silently, again. Either leave the prefix unset, or add it to both `Resource`
lines at the same time.

## The uptime check pages from us-east-1, wherever the stack is

`UptimeHealthCheck` is a Route 53 health check on `https://<HostName>/healthz` — served at the
root by the UI's nginx, outside the ingress's `/api` rule, so one request exercises DNS, the ALB,
the certificate and a UI pod. It is created whenever `AlertEmail` is set, in any region, and not
at all when it is empty: a health check nobody is paged by is a monthly charge for nothing, and
an empty parameter creating nothing is how the rest of this template behaves.

The **alarm** is the part that cannot be. Route 53 publishes `AWS/Route53 HealthCheckStatus` into
`us-east-1` and nowhere else, whatever region created the check, so an alarm on it in
`ap-south-1` sits in `INSUFFICIENT_DATA` for ever — an alert that never fires, which is worse
than no alert. The template therefore declares `UptimeAlarm` only when the stack itself is in
`us-east-1`. Everywhere else, create it once by hand against the stack's own outputs:

```bash
HC=$(aws cloudformation describe-stacks --stack-name rch-prod --region ap-south-1 \
  --query "Stacks[0].Outputs[?OutputKey=='UptimeHealthCheckId'].OutputValue" --output text)
# The SNS topic must be in us-east-1 too — an alarm can only publish to a topic in its own region.
TOPIC=$(aws sns create-topic --name rch-prod-uptime --region us-east-1 --query TopicArn --output text)
aws sns subscribe --region us-east-1 --topic-arn "$TOPIC" --protocol email --notification-endpoint ops@example.com
aws cloudwatch put-metric-alarm --region us-east-1 \
  --alarm-name rch-prod-uptime --namespace AWS/Route53 --metric-name HealthCheckStatus \
  --dimensions Name=HealthCheckId,Value="$HC" \
  --statistic Minimum --period 60 --evaluation-periods 3 --threshold 1 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching \
  --alarm-actions "$TOPIC" --ok-actions "$TOPIC"
```

`AlertEmail` still earns its keep in the regional stack: it creates `rch-<env>-alerts` and its
email subscription there, for anything else that wants somewhere to page. **The subscription has
to be confirmed from the inbox** — an unconfirmed one is a topic publishing into nothing.

## Importing `dev`

The `dev` environment's resources already exist — they were created by hand with the AWS CLI,
including the RDS instance's rename from `rch-staging` to `rch-dev` and a freshly-created,
still-empty `rch/dev` Secrets Manager secret. Bringing them under this stack is a CloudFormation
**IMPORT** change set, not a plain create.

**Before running this**, fetch the ACM certificate ARN for `rch.hashtrickstechnologies.com`
(it was being (re-)requested at the time this template was written — `aws acm list-
certificates --region ap-south-1` and `aws acm describe-certificate` will show it once issued)
and replace the placeholder `"FILL-CERT-ARN"` in `deploy/cfn/dev.import.json` with the real
ARN. A `FAILED`/`PENDING_VALIDATION` certificate cannot be imported — wait for `ISSUED`.

```bash
aws cloudformation create-change-set \
  --stack-name rch-dev \
  --change-set-name rch-dev-import \
  --change-set-type IMPORT \
  --template-body file://deploy/cfn/rch-env.yaml \
  --parameters file://deploy/cfn/dev.params.json \
  --resources-to-import file://deploy/cfn/dev.import.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --region ap-south-1

aws cloudformation describe-change-set \
  --stack-name rch-dev --change-set-name rch-dev-import --region ap-south-1
# Read every change before executing. Nine resources import; the CAA record for
# rch.hashtrickstechnologies.com does not exist yet (see below) and shows as a plain CREATE
# in the same change set — that is expected, not a mistake in the import file.

aws cloudformation execute-change-set \
  --stack-name rch-dev --change-set-name rch-dev-import --region ap-south-1

# An IMPORT change set may not create anything: every resource the template declares must be in
# the import list (the CAA record included), so create any that do not exist yet by hand first.
# Confirm drift-free: run the same create-change-set again (any change-set-type) with the
# same template and parameters. An empty change set (or one containing only the DB instance's
# `env` tag, see below) is the pass condition — anything else means a property in the template
# does not match what is actually deployed and needs to be fixed before relying on this stack.
aws cloudformation create-change-set \
  --stack-name rch-dev --change-set-name rch-dev-verify \
  --template-body file://deploy/cfn/rch-env.yaml \
  --parameters file://deploy/cfn/dev.params.json \
  --capabilities CAPABILITY_NAMED_IAM --region ap-south-1
aws cloudformation describe-change-set \
  --stack-name rch-dev --change-set-name rch-dev-verify --region ap-south-1
# Delete the verify change set without executing it once you've read it, either way:
aws cloudformation delete-change-set \
  --stack-name rch-dev --change-set-name rch-dev-verify --region ap-south-1
```

**Known one-line diff to expect on the first verify.** The RDS instance's rename from
`rch-staging` to `rch-dev` did not update its `env` tag — it still reads `env=staging` as of
this writing. The template declares `env=dev`. The verify change set will show a tag-only
update on `Database`; that's a Tags-are-mutable-in-place, non-disruptive change, not drift in
anything that matters. Executing it corrects the tag; leaving it is also harmless.

**The next change set on `rch-dev` is deliberately not empty, and it is an outage window.** The
import is done; the audit then changed the template underneath it, so the first
`aws cloudformation deploy` after this commit is a real update and should read as one. Expect:
`DbParameterGroup` and `RdsMonitoringRole` created; lifecycle policies added to both ECR
repositories; six subjects removed from `GithubDeployRole`'s trust policy; and a modify on
`Database` for the parameter group, `AutoMinorVersionUpgrade`, the CloudWatch logs export,
Performance Insights, Enhanced Monitoring and the two windows. (No health check and no SNS topic:
`dev.params.json` leaves `AlertEmail` empty, which creates neither.) **Read every line before
executing it**, as the import instructions above already say.

Nothing in that list **replaces** the instance. Three items in it can **reboot** it, though —
attaching a parameter group containing a static parameter is "Some interruptions", not "No
interruption" — so run it off-hours, and read "Run this stack update off-hours" below before
scheduling it. The trust-policy change is the other one to be deliberate about: a GitHub workflow
that deploys without declaring an `environment:` stops being able to assume the role, which is
the point of it.

**`DbMasterPassword` on the import.** `dev.params.json` passes the literal string `"IMPORT"`
for this parameter. CloudFormation's `AWS::RDS::DBInstance` import does not read
`MasterUserPassword` back from the live instance and does not compare it — the property only
has to be *present* in the template for the import to be accepted, and its value is not applied
to the already-existing instance. The real password stays whatever it was set to outside
CloudFormation; nothing here changes it. This is different from a **create** (a future `staging`
or `prod` stack): there, `MasterUserPassword` is a real write, so that stack's params file must
carry the actual password, not a placeholder — treat any params file with a real password in it
as a secret and do not commit it.

**The CAA record is not imported, only created.** No CAA record exists yet for
`rch.hashtrickstechnologies.com` (the hostname is new), so `dev.import.json` does not list
it — an `IMPORT` change set can still create resources that aren't in `ResourcesToImport`
alongside the ones that are, as long as at least one resource actually imports, so the CAA
record is simply created fresh in the same operation.

## Creating `staging` or `prod`

Once `dev` exists (for the shared-resource exports) and the environment's own params file has
every `FILL` replaced with a real value — most importantly `DbMasterPassword`, which for a
fresh stack is the actual password being set, not a placeholder:

```bash
aws cloudformation create-stack \
  --stack-name rch-prod \
  --template-body file://deploy/cfn/rch-env.yaml \
  --parameters file://deploy/cfn/prod.params.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --region ap-south-1
```

`prod.params.json` pre-fills the suggested host, instance class (`db.t4g.medium`), Multi-AZ
(`true`), deletion protection (`true`), backup retention (`14` days), storage autoscaling to
100 GiB, Performance Insights, and a security group admitting only the EKS node group — **eight
of the nine things `deploy/RUNBOOK.md` §11 step 2 asks for.** It reuses `dev`'s VPC and subnets
since the cluster serves every environment as a namespace in one VPC
(`deploy/eksctl/cluster.yaml`). `staging.params.json` is the same shape one tier down —
`db.t4g.small`, single-AZ, 7-day backups, 40 GiB ceiling — for a staging tier that does not exist
yet; nothing in it has been read from AWS, and `FILL`s stay `FILL` until someone actually
provisions staging.

**The ninth is private subnets, and this template does not deliver them.** §11 step 2 says "in
private subnets". Every environment's database, production's included, sits in the imported
`rch` DB subnet group, which is the account's default VPC's three **public** subnets — the same
ones the cluster's nodes and the ALB use (`deploy/cfn/dev.import.json`, `prod.params.json`'s
`SubnetIds`). Closing that gap is not a parameter: it needs private subnets created in the VPC, a
route table with a NAT gateway, and a per-environment `DBSubnetGroup` replacing the shared import
— and moving an existing instance between subnet groups is a modify with an outage, not a
property flip. What limits the exposure today is that `PubliclyAccessible: false` means the
instance has no public IP and no internet gateway route to it, and that staging and prod now
admit 5432 only from the EKS node group's security group. **Put it on the §11 follow-up list;
do not read "matches the checklist" as including it.**

**Check `HostName` before creating a prod stack.** `prod.params.json` carries
`rch.hashtrickstechnologies.com` — which is the host **dev is live on right now**
(`deploy/RUNBOOK.md` §15). Creating a prod stack with it unchanged mints a second ACM certificate
and a second Route 53 health check against the running dev application, and the go-live A-alias
would then be a straight fight between the two environments for one name. Decide the production
hostname first: either move dev to `rch-dev.hashtrickstechnologies.com` and let prod take this
one, or give prod its own.

**Four `FILL`s, and what each one is.** A `FILL` left in place fails the `create-stack` call
rather than creating something half-configured — `NodeSecurityGroupId` and `AlbLogsBucketName`
fail on their `AllowedPattern`, `AlertEmail` fails when SNS rejects the endpoint, and
`DbMasterPassword` would set the literal word as the password, which is the one to be careful of.

| Key | What goes in |
|---|---|
| `NodeSecurityGroupId` | The EKS node group's security group — the only source admitted to 5432. `aws eks describe-cluster --name rch --region ap-south-1 --query cluster.resourcesVpcConfig.clusterSecurityGroupId` |
| `AlertEmail` | Subscribes an address to `rch-<env>-alerts` in **this** region, and creates the Route 53 health check. The subscription must then be confirmed from the inbox. Note that `rch-<env>-alerts` is **not** the topic the uptime alarm pages — that alarm and its topic have to live in `us-east-1` (see "The uptime check pages from us-east-1" above); this one exists for anything else in-region that wants somewhere to publish. |
| `AlbLogsBucketName` | A globally-unique bucket name, e.g. `rch-alb-logs-<account>`. Empty is a valid answer — it means no ALB access logs, and the chart must then leave `access_logs.s3.*` off. |
| `DbMasterPassword` | The real password, because a `create-stack` actually sets it. Treat the params file as a secret and do not commit it with the value in. |

**An IMPORT change set cannot bring a brand-new environment under this template any more.** An
import may create nothing, and every resource the template declares must be in the import list —
which now includes a parameter group, a security group, a monitoring role, a health check and
(conditionally) an SNS topic and a bucket that a hand-built environment would not already have.
Stand `staging` and `prod` up with `create-stack`, as above; the import path exists because
`dev`'s resources predated the template, not because it is the way to build an environment.

## What's retained on delete

`DeletionPolicy: Retain` on the DB instance, the Secrets Manager secret, both ECR repositories,
the OIDC provider and the ALB access-log bucket — deleting the stack leaves all five in place,
and in the bucket's case that is the point: the logs are the record of what the ALB served, and a
stack delete is not a decision to destroy them. Deliberately not on the `rch-github-deploy` role,
the DB subnet group, either DB security group, the DB parameter group, the monitoring role, the
health check or the SNS topic: all cheap to recreate. Not on the ACM certificate or the CAA
record either, for the same reason.

## The OIDC provider (and the rest of the shared set) is account-global — do not duplicate it

`token.actions.githubusercontent.com` can only be registered once per AWS account; so, in
practice, can a role or ECR repository of a given name, or a DB subnet group of a given name. A
`staging` or `prod` stack that declared its own copies of any of these four resources would fail
outright on create (`EntityAlreadyExists` / the name is already taken) the moment `dev`'s stack
already owns them. That's why `IsDev` gates them and every other environment imports by
`Fn::ImportValue` instead — see "Why the resources are split" above. Nothing about this is
specific to the OIDC provider; it's the sharpest example of a pattern that applies to all four.

The DB security group is the one that left this list: each non-dev environment now names its own
`rch-rds-<env>`, so there is no name to collide over and no shared rule to inherit.

## The deploy role admits GitHub *environments* only

`rch-github-deploy`'s trust policy used to admit `repo:<repo>:ref:refs/heads/{develop,staging,
production}` alongside `repo:<repo>:environment:{dev,staging,production}`, in both the mutable
and immutable subject forms. `deploy.yml:27` sets an `environment:` on every job that deploys, so
the environment subjects alone cover every real deploy — and the `production` environment is
where the required reviewer lives. The `ref:` subjects granted exactly one thing the environment
subjects did not: they let a workflow running on `refs/heads/production` **without** declaring an
environment assume the role, which is the approval gate going missing. They are gone.

```bash
aws iam get-role --role-name rch-github-deploy --query 'Role.AssumeRolePolicyDocument'
```

## What an IMPORT change set will and will not accept (learned importing `rch-dev`)

- It may create nothing: every resource the template declares must be in the import list, so a
  resource that does not exist yet (the CAA record on a fresh name) sits behind a condition
  (`CreateCaaRecord`, `false` for the import) and is created by the UPDATE that follows.
- It may add no `Outputs` and no stack-level `--tags`: run the import with a copy of the template
  whose `Outputs:` section is removed and without `--tags`; the follow-up
  `aws cloudformation deploy` with the full template adds both.
- Every imported resource must carry a `DeletionPolicy` (all are `Retain` here).
- A Route 53 record's import identifier is `{HostedZoneId, Name, Type}` — it was simpler to let
  the update create the CAA record than to import a hand-made one.
- `dev.params.json` is committed with `CreateCaaRecord=true`, the value the stack holds after the
  update; pass `false` only for a first import.
