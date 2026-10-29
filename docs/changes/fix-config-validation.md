# Configuration validation

Lodestar now uses defaults only when `config.json` is absent. Invalid JSON, malformed fields, and read failures stop the command with the configuration path and a repair hint; `config set` therefore leaves broken input untouched. Valid null/default values and unknown extension fields remain supported when settings are loaded and edited.
