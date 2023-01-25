# Capsule Schema

```json
{
  "serial": {
    "type": "String",
    "required": true,
    "unique": true,
  },
  "status": {
    "type": "String",
    "enum": ["unknown", "active", "retired", "destroyed"],
    "required": true,
  },
  "type": {
    "type": "String",
    "enum": ["Dragon 1.0", "Dragon 1.1", "Dragon 2.0"],
    "required": true,
  },
  "dragon": {
    "type": "UUID",
  },
  "reuse_count": {
    "type": "Number",
    "default": 0,
  },
  "water_landings": {
    "type": "Number",
    "default": 0,
  },
  "land_landings": {
    "type": "Number",
    "default": 0,
  },
  "last_update": {
    "type": "String",
    "default": null,
  },
  "launches": [{
    "type": "UUID",
  }],
}
```
