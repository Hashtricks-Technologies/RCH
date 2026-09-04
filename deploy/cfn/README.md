# `deploy/cfn` — RCH environment resources

`rch-env.yaml` codifies everything the account owner created by hand with the AWS CLI: the
Postgres instance, its subnet group and security group, the two ECR repositories, the GitHub
Actions OIDC provider and deploy role, a per-environment Secrets Manager secret, an ACM
certificate and its CAA record. It does **not** cover the EKS cluster (`deploy/eksctl/
cluster.yaml`), the load balancer controller, subnet tags or any Kubernetes object — those stay
exactly as they are.

One template, one stack per environment (`dev`, `staging`, `prod` — only `dev` exists today).
Every `aws cloudformation` call below needs `--capabilities CAPABILITY_NAMED_IAM` because the
template names an `AWS::IAM::Role`.

## Why the resources are split "shared" vs "per-environment"

A handful of the CLI-created resources are singletons AWS will not let a second stack recreate:
the DB subnet group (`rch`) and security group (`rch-rds`) are one VPC-wide pair serving every
environment's database, both ECR repositories (`rch-api`, `rch-ui`) are one registry for every
environment's images, and the GitHub Actions OIDC provider is account-global outright — the
role `rch-github-deploy`'s own trust policy already admits both `staging` and `production`
branch refs and GitHub environments in one document, so it is shared too.

The template's `IsDev` condition (`Env == "dev"`) gates all five: only a stack with `Env=dev`
declares them. A `staging` or `prod` stack skips them and instead reads their identifiers back
with `Fn::ImportValue` from five fixed export names the `dev` stack publishes (`rch-shared-db-
subnet-group-name`, `rch-shared-db-security-group-id`, `rch-shared-ecr-api-uri`, `rch-shared-
ecr-ui-uri`, `rch-shared-github-deploy-role-arn`). **This means the `dev` stack must exist
before any `staging` or `prod` stack is created** — the import fails otherwise, plainly, with
"No export named ... found."

Everything else — the DB instance, its Secrets Manager secret, the ACM certificate, the CAA
record — is genuinely per-environment; every stack creates its own, named from the `Env`
parameter (`rch-${Env}`, `rch/${Env}`, the environment's own `HostName`).

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

`prod.params.json` pre-fills the suggested host (`rch.hashtrickstechnologies.com`), instance
class (`db.t4g.small`), Multi-AZ (`true`), deletion protection (`true`) and backup retention
(`14` days) per the go-live checklist (`deploy/RUNBOOK.md` §11) — reuses `dev`'s VPC and subnets
since the cluster serves every environment as a namespace in one VPC (`deploy/eksctl/
cluster.yaml`); change those two if production ever gets a dedicated VPC. `staging.params.json`
is the same shape for a future staging tier that does not exist yet — nothing in it has been
read from AWS, it is a template of a template, and `FILL`s stay `FILL` until someone actually
provisions staging (at which point that provisioning is itself a CLI-then-import step exactly
like `dev`'s, not a plain `create-stack`).

## What's retained on delete

`DeletionPolicy: Retain` on the DB instance, the Secrets Manager secret, both ECR repositories
and the OIDC provider — deleting the stack leaves all four in place. Deliberately not on the
`rch-github-deploy` role, the DB subnet group or the DB security group: cheap to recreate, and
the task's own retain list didn't call for it. Not on the ACM certificate or the CAA record
either, for the same reason.

## The OIDC provider (and the rest of the shared set) is account-global — do not duplicate it

`token.actions.githubusercontent.com` can only be registered once per AWS account; so, in
practice, can a role or ECR repository of a given name, or a DB subnet group / security group
of a given name. A `staging` or `prod` stack that declared its own copies of any of these five
resources would fail outright on create (`EntityAlreadyExists` / the name is already taken) the
moment `dev`'s stack already owns them. That's why `IsDev` gates them and every other
environment imports by `Fn::ImportValue` instead — see "Why the resources are split" above.
Nothing about this is specific to the OIDC provider; it's the sharpest example of a pattern that
applies to all five.

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
