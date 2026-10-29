// The example watch config, embedded so `watch init` works from the single-file bundle.
// ../watch.example.json is the same content (a test keeps them in step).
export const EXAMPLE_CONFIG = {
  profile: "work-truck upfitter (example)",
  keywords: [
    "truck bod", "service bod", "utility bod", "dump bod", "upfit", "mechanic truck", "service truck", "work truck",
    "chassis", "crane", "lube", "flatbed", "truck equipment", "vocational", "bucket truck", "digger derrick",
    "van upfit", "cargo van", "heavy and compact construction",
  ],
  exclude_keywords: [
    "electrification", "charging", "curb", "consult", "ambulance", "fire", "school bus", "office", "fuel", "surveillance", "MRO",
    "airport", "rental", "refuse", "salt", "recycling", "vegetation",
  ],
  contract_keywords: [
    "truck bod", "service bod", "dump bod", "upfit", "work truck", "chassis", "crane", "flatbed", "truck equipment",
    "bucket truck", "digger derrick", "van upfit",
  ],
  competitor_brands: [
    "Stellar", "Knapheide", "Reading", "Auto Crane", "IMT", "Maintainer", "Miller", "Ranger Design", "Bedrock",
    "Altec", "Terex", "Elliott",
  ],
  closing_soon_days: 14,
  contract_expiring_months: 24,
};
