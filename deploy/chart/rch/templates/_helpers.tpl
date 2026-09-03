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
reference, which sidesteps the first-install ordering problem where a
pre-install hook Job would otherwise run before the ConfigMap/Secret exist.
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
{{- if .Values.secrets.create }}
{{- range $k, $v := .Values.secrets.values }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- else if .Values.secrets.externalSecret.enabled }}
{{- range $k := list "DATABASE_URL" "JWT_PRIVATE_KEY" "JWT_PUBLIC_KEY" "JWT_PREVIOUS_PUBLIC_KEY" }}
- name: {{ $k }}
  valueFrom:
    secretKeyRef: { name: {{ include "rch.secretName" $ }}, key: {{ $k }} }
{{- end }}
{{- end }}
{{- end -}}
