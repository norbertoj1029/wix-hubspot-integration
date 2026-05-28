export const defaultMappings = [
  {
    id: "map_email",
    wixField: "email",
    hubspotProperty: "email",
    direction: "bidirectional",
    transform: "lowercase"
  },
  {
    id: "map_first_name",
    wixField: "firstName",
    hubspotProperty: "firstname",
    direction: "bidirectional",
    transform: "trim"
  },
  {
    id: "map_last_name",
    wixField: "lastName",
    hubspotProperty: "lastname",
    direction: "bidirectional",
    transform: "trim"
  },
  {
    id: "map_phone",
    wixField: "phone",
    hubspotProperty: "phone",
    direction: "bidirectional",
    transform: "trim"
  },
  {
    id: "map_company",
    wixField: "company",
    hubspotProperty: "company",
    direction: "bidirectional",
    transform: "trim"
  },
  {
    id: "map_utm_source",
    wixField: "utm_source",
    hubspotProperty: "wix_utm_source",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_utm_medium",
    wixField: "utm_medium",
    hubspotProperty: "wix_utm_medium",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_utm_campaign",
    wixField: "utm_campaign",
    hubspotProperty: "wix_utm_campaign",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_page_url",
    wixField: "pageUrl",
    hubspotProperty: "wix_page_url",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_referrer",
    wixField: "referrer",
    hubspotProperty: "wix_referrer",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_utm_term",
    wixField: "utm_term",
    hubspotProperty: "wix_utm_term",
    direction: "wix-to-hubspot",
    transform: "trim"
  },
  {
    id: "map_utm_content",
    wixField: "utm_content",
    hubspotProperty: "wix_utm_content",
    direction: "wix-to-hubspot",
    transform: "trim"
  }
];
