{{- define "rch.name" -}}{{ .Chart.Name }}{{- end -}}
{{- /*
rch.labels renders as a single comma-joined line (not one key per line) because
every call site embeds it inside a flow-style `{ ... }` mapping - YAML flow
mappings need commas between entries, not bare newlines.
*/ -}}
{{- define "rch.labels" -}}
app.kubernetes.io/name: {{ include "rch.name" . }}, app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/version: {{ .Values.image.tag | quote }}, app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "rch.image" -}}{{ if .registry }}{{ .registry }}/{{ end }}{{ .name }}:{{ .tag }}{{- end -}}
{{- define "rch.secretName" -}}{{ .Release.Name }}-secrets{{- end -}}
{{- define "rch.sa" -}}{{ if .Values.serviceAccount.create }}{{ .Release.Name }}{{ else }}default{{ end }}{{- end -}}
{{- /*
rch.env renders an explicit `env:` list: NODE_ENV, PORT, one plain `value:` per entry of a
component's env map, then one secretKeyRef per secret key the container is allowed to read. It
is called only through the four per-component lists below, so each container names exactly the
secrets it uses and nothing else - the long-running api holds no superuser URL, and neither audit
container ever sees JWT_PRIVATE_KEY or SEED_PASSWORD. Non-secret settings are inlined rather than
read from a ConfigMap, so the pod's checksum/config annotation hashes what the container reads.

  rch.apiEnv          the api container                  DATABASE_URL (rch_app), JWT_PRIVATE_KEY,
                                                         JWT_PUBLIC_KEY, JWT_PREVIOUS_PUBLIC_KEY,
                                                         SEED_PASSWORD, RAZORPAY_KEY_ID,
                                                         RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
  rch.apiCliEnv       the api pod's migrate initContainer MIGRATE_DATABASE_URL (rch) + everything
                      and the purge CronJob              rch.apiEnv names
  rch.auditEnv        the audit container                AUDIT_DATABASE_URL (rch_audit),
                                                         JWT_PUBLIC_KEY, JWT_PREVIOUS_PUBLIC_KEY
  rch.auditMigrateEnv the audit pod's audit-migrate      MIGRATE_DATABASE_URL (rch) + everything
                      initContainer                      rch.auditEnv names

The API's CLIs connect with MIGRATE_DATABASE_URL and read the runtime role's name and password
from DATABASE_URL; the audit migrate CLI reads them from AUDIT_DATABASE_URL.

Every secret is ALWAYS wired via valueFrom.secretKeyRef against the Secret named by
rch.secretName - never inlined as a plaintext `value:`. .Values.secrets.create only decides
whether secret.yaml renders that Secret from values (staging/dev);
.Values.secrets.externalSecret.enabled decides whether externalsecret.yaml renders an
ExternalSecret that has the External Secrets Operator sync the same Secret name from the external
store (prod). Either way the consuming containers read the same secretKeyRef, so which template
produced the Secret is invisible to them. Both secret.yaml and externalsecret.yaml are plain
release resources (no helm.sh/hook annotations) - see those templates for why turning them into
hooks was tried and reverted.

The optional: true keys are exactly the ones listed in rch.optionalSecretKeys, below.
JWT_PREVIOUS_PUBLIC_KEY is only populated during a key-rotation window; outside of that window the
key legitimately does not exist in the Secret. The three RAZORPAY_* keys switch on QR ordering's
online payment (RUNBOOK §19): a Secret without any of them is an environment that takes no QR
orders, and the API answers 503 to placing one rather than refusing to start. They go together:
one or two of them makes config.ts refuse to start the API, which secret.yaml turns into a render
failure on the values path (the ExternalSecret path cannot see the keys). Every other key is required, and
a pod that cannot find one must fail to start rather than come up half-configured - so a key is
made optional only by naming it in that list, never by widening a comparison. render.test.sh
asserts SEED_PASSWORD never renders `optional`, and that the list is exactly these four.

SEED_PASSWORD has no default in apps/api/src/config.ts, so the api container will not start
without it - it is a secret key rather than an api.env entry because it is the password the six
seeded accounts start on, and a published default would be the same password on every host that
ever ran the seed. The seed itself is a CLI run by hand inside the container (RUNBOOK §11), never
part of a rollout; what the env entry buys is that the password is in the Secret rather than in a
shell history.
*/ -}}
{{- define "rch.optionalSecretKeys" -}}JWT_PREVIOUS_PUBLIC_KEY RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET{{- end -}}
{{- define "rch.env" -}}
- name: NODE_ENV
  value: production
- name: PORT
  value: {{ .port | quote }}
{{- range $k, $v := .env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- $optional := splitList " " (include "rch.optionalSecretKeys" .root) }}
{{- range $k := .keys }}
- name: {{ $k }}
  valueFrom:
    secretKeyRef: { name: {{ include "rch.secretName" $.root }}, key: {{ $k }}{{ if has $k $optional }}, optional: true{{ end }} }
{{- end }}
{{- end -}}
{{- define "rch.apiEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3000 "env" .Values.api.env "keys" (list "DATABASE_URL" "JWT_PRIVATE_KEY" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY" "SEED_PASSWORD" "RAZORPAY_KEY_ID" "RAZORPAY_KEY_SECRET" "RAZORPAY_WEBHOOK_SECRET")) }}
{{- end -}}
{{- define "rch.apiCliEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3000 "env" .Values.api.env "keys" (list "MIGRATE_DATABASE_URL" "DATABASE_URL" "JWT_PRIVATE_KEY" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY" "SEED_PASSWORD" "RAZORPAY_KEY_ID" "RAZORPAY_KEY_SECRET" "RAZORPAY_WEBHOOK_SECRET")) }}
{{- end -}}
{{- define "rch.auditEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3100 "env" .Values.audit.env "keys" (list "AUDIT_DATABASE_URL" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY")) }}
{{- end -}}
{{- define "rch.auditMigrateEnv" -}}
{{ include "rch.env" (dict "root" . "port" 3100 "env" .Values.audit.env "keys" (list "MIGRATE_DATABASE_URL" "AUDIT_DATABASE_URL" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY")) }}
{{- end -}}
