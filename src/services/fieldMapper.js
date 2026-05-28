function applyTransform(value, transform) {
  if (value === undefined || value === null) return value;
  const stringValue = String(value);
  if (transform === "lowercase") return stringValue.trim().toLowerCase();
  if (transform === "uppercase") return stringValue.trim().toUpperCase();
  if (transform === "trim") return stringValue.trim();
  return value;
}

function allowedByDirection(mapping, direction) {
  return mapping.direction === "bidirectional" || mapping.direction === direction;
}

export function mapWixFieldsToHubSpot(input, mappings) {
  return mappings
    .filter((mapping) => allowedByDirection(mapping, "wix-to-hubspot"))
    .reduce((output, mapping) => {
      if (Object.prototype.hasOwnProperty.call(input, mapping.wixField)) {
        output[mapping.hubspotProperty] = applyTransform(input[mapping.wixField], mapping.transform);
      }
      return output;
    }, {});
}

export function mapHubSpotPropertiesToWix(input, mappings) {
  return mappings
    .filter((mapping) => allowedByDirection(mapping, "hubspot-to-wix"))
    .reduce((output, mapping) => {
      if (Object.prototype.hasOwnProperty.call(input, mapping.hubspotProperty)) {
        output[mapping.wixField] = applyTransform(input[mapping.hubspotProperty], mapping.transform);
      }
      return output;
    }, {});
}
