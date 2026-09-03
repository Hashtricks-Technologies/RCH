{{- define "rch.name" -}}{{ .Chart.Name }}{{- end -}}
{{- /*
rch.labels renders as a single comma-joined line (not one key per line) because
every call site embeds it inside a flow-style `{ ... }` mapping — YAML flow
mappings need commas between entries, not bare newlines.
*/ -}}
{{- define "rch.labels" -}}
app.kubernetes.io/name: {{ include "rch.name" . }}, app.kubernetes.io/instance: {{ .Release.Name }}, app.kubernetes.io/version: {{ .Values.image.tag | quote }}, app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "rch.image" -}}{{ if .registry }}{{ .registry }}/{{ end }}{{ .name }}:{{ .tag }}{{- end -}}
{{- define "rch.secretName" -}}{{ .Release.Name }}-secrets{{- end -}}
{{- define "rch.sa" -}}{{ if .Values.serviceAccount.create }}{{ .Release.Name }}{{ else }}default{{ end }}{{- end -}}
{{- /*
rch.envList renders an explicit `env:` list for containers that need the API's
runtime configuration. It exists so the Deployment and the pre-upgrade
migration Job (and, for consistency, the purge CronJob) never drift: all three
build their env from the same values instead of an envFrom/ConfigMap+Secret
reference for the non-secret settings.

The four secret keys (DATABASE_URL, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY,
JWT_PREVIOUS_PUBLIC_KEY) are ALWAYS wired via valueFrom.secretKeyRef against
the rendered Secret named by rch.secretName — never inlined as plaintext
`value:` entries. .Values.secrets.create only decides whether secret.yaml
renders that Secret from values (staging/dev); .Values.secrets.externalSecret.enabled
decides whether externalsecret.yaml renders an ExternalSecret that has the
External Secrets Operator sync the same Secret name from the external store
(prod). Either way the consuming containers read the same secretKeyRef, so
which template produced the Secret is invisible to them. Both secret.yaml and
externalsecret.yaml run as pre-install,pre-upgrade hooks ordered before the
migrate Job so the Secret exists by the time it's referenced (see those
templates for details).

JWT_PREVIOUS_PUBLIC_KEY is marked optional: true because it is only populated
during a key-rotation window; outside of that window the key legitimately
does not exist in the Secret.
*/ -}}
{{- define "rch.envList" -}}
- name: NODE_ENV
  value: production
- name: PORT
  value: "3000"
{{- range $k, $v := .Values.api.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- range $k := list "DATABASE_URL" "JWT_PRIVATE_KEY" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY" }}
- name: {{ $k }}
  valueFrom:
    secretKeyRef: { name: {{ include "rch.secretName" $ }}, key: {{ $k }}{{ if eq $k "JWT_PREVIOUS_PUBLIC_KEY" }}, optional: true{{ end }} }
{{- end }}
{{- end -}}
