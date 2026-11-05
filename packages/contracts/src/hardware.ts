import * as Schema from "effect/Schema";

/** Kitty hardware toolchain checks. See docs/kitty/开发计划.md. */
export const HardwareCheckId = Schema.Literals([
  "esp-idf",
  "python-env",
  "esptool",
  "kicad",
  "serial",
]);
export type HardwareCheckId = typeof HardwareCheckId.Type;

export const HardwareCheckStatus = Schema.Literals(["ok", "warning", "missing"]);
export type HardwareCheckStatus = typeof HardwareCheckStatus.Type;

export const HardwareDoctorCheck = Schema.Struct({
  id: HardwareCheckId,
  status: HardwareCheckStatus,
  version: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  detail: Schema.String,
});
export type HardwareDoctorCheck = typeof HardwareDoctorCheck.Type;

export const HardwareIdfInstallation = Schema.Struct({
  path: Schema.String,
  version: Schema.String,
});
export type HardwareIdfInstallation = typeof HardwareIdfInstallation.Type;

export const HardwareDoctorReport = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Array(HardwareDoctorCheck),
  idfInstallations: Schema.Array(HardwareIdfInstallation),
  serialPorts: Schema.Array(Schema.String),
});
export type HardwareDoctorReport = typeof HardwareDoctorReport.Type;

export const HardwareDoctorInput = Schema.Struct({
  idfPath: Schema.optional(
    Schema.String.annotate({
      description: "ESP-IDF checkout to check. Defaults to IDF_PATH, then the newest found.",
    }),
  ),
});
export type HardwareDoctorInput = typeof HardwareDoctorInput.Type;
