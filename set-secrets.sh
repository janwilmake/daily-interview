#!/bin/bash

# Process each line in .dev.vars
while IFS= read -r line || [[ -n "$line" ]]; do
  # Trim leading/trailing whitespace
  trimmed_line="${line#"${line%%[![:space:]]*}"}"
  trimmed_line="${trimmed_line%"${trimmed_line##*[![:space:]]}"}"

  # Skip empty lines and comments
  if [[ -z "$trimmed_line" || "$trimmed_line" == '#'* ]]; then
    continue
  fi

  # Split key and value at first '='
  key="${trimmed_line%%=*}"
  value="${trimmed_line#*=}"

  # Trim whitespace from key and value
  key="${key%"${key##*[![:space:]]}"}"
  key="${key#"${key%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#"${value%%[![:space:]]*}"}"

  # Set secret if key is valid
  if [[ -n "$key" ]]; then
    # echo "$key to $value"
    gh secret set "$key" -b "$value"
  else
    echo "Warning: Invalid line '${line}' - missing key"
  fi
done < .dev.vars