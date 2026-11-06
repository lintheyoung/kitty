import type { KittyBoard, KittyPinmap } from "@t3tools/contracts";

/**
 * The standard Board Test Firmware: an ESP-IDF app that checks the chip, flash,
 * a supply divider, the I2C bus, an IMU's WHO_AM_I and a GPIO loopback, printing
 * Kitty JSON lines. sdkconfig.defaults says what to check, from board.json and pinmap.json.
 */

const BOARD_TEST_VERSION = "0.1.0";

/** WHO_AM_I register and value of common IMUs, matched on the part name. */
const IMU_IDS: ReadonlyArray<{
  readonly match: RegExp;
  readonly register: number;
  readonly id: number;
}> = [
  { match: /MPU-?6050/i, register: 0x75, id: 0x68 },
  { match: /MPU-?6500/i, register: 0x75, id: 0x70 },
  { match: /MPU-?9250/i, register: 0x75, id: 0x71 },
  { match: /ICM-?42688/i, register: 0x75, id: 0x47 },
  { match: /ICM-?20948/i, register: 0x00, id: 0xea },
  { match: /LSM6DS3/i, register: 0x0f, id: 0x69 },
  { match: /LSM6DSO/i, register: 0x0f, id: 0x6c },
  { match: /LSM6DSR/i, register: 0x0f, id: 0x6b },
  { match: /QMI8658/i, register: 0x00, id: 0x05 },
  { match: /BMI160/i, register: 0x00, id: 0xd1 },
  { match: /BMI270/i, register: 0x00, id: 0x24 },
  { match: /BMI088/i, register: 0x00, id: 0x1e },
];

const hex = (value: number) => `0x${value.toString(16).padStart(2, "0")}`;

/** `0x68`, `68h` or `104` → 104; anything else → undefined. */
export function parseI2cAddress(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim().toLowerCase();
  const value = /^0x[0-9a-f]{1,2}$/.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : /^[0-9a-f]{1,2}h$/.test(trimmed)
      ? Number.parseInt(trimmed.slice(0, -1), 16)
      : /^\d{1,3}$/.test(trimmed)
        ? Number.parseInt(trimmed, 10)
        : Number.NaN;
  return value >= 0x08 && value <= 0x77 ? value : undefined;
}

export interface BoardTestSettings {
  readonly i2c?: { readonly sda: number; readonly scl: number; readonly from: string };
  readonly devices: ReadonlyArray<{ readonly name: string; readonly address: number }>;
  readonly imu?: {
    readonly name: string;
    readonly address: number;
    readonly register: number;
    readonly id?: number | undefined;
  };
}

/** The I2C bus and devices to test, from board.json first and the schematic's net names second. */
export function boardTestSettings(
  board: KittyBoard | undefined,
  pinmap: KittyPinmap | undefined,
): BoardTestSettings {
  const declared = board?.interfaces?.i2c?.[0];
  let i2c: BoardTestSettings["i2c"];
  if (declared) {
    i2c = { sda: declared.sda, scl: declared.scl, from: `board.json i2c "${declared.name}"` };
  } else if (pinmap) {
    const pinFor = (name: RegExp) =>
      pinmap.pins.find((pin) => pin.connected && name.test(pin.net.split("/").at(-1) ?? ""));
    const sda = pinFor(/(^|_)SDA\d*$/i);
    const scl = pinFor(/(^|_)SCL\d*$/i);
    if (sda && scl) {
      i2c = { sda: sda.gpio, scl: scl.gpio, from: `schematic nets ${sda.net} / ${scl.net}` };
    }
  }
  const devices = (board?.peripherals ?? []).flatMap((peripheral) => {
    const address = parseI2cAddress(peripheral.address);
    const onI2c = !peripheral.interface || /i2c/i.test(peripheral.interface);
    return address !== undefined && onI2c ? [{ name: peripheral.name, address }] : [];
  });
  const imuPeripheral = (board?.peripherals ?? []).find(
    (peripheral) =>
      /imu|accel|gyro/i.test(peripheral.type) && parseI2cAddress(peripheral.address) !== undefined,
  );
  let imu: BoardTestSettings["imu"];
  if (imuPeripheral) {
    const known = IMU_IDS.find((entry) =>
      entry.match.test(`${imuPeripheral.part ?? ""} ${imuPeripheral.name}`),
    );
    imu = {
      name: imuPeripheral.name,
      address: parseI2cAddress(imuPeripheral.address) ?? 0,
      register: known?.register ?? 0x75,
      id: known?.id,
    };
  }
  return { ...(i2c ? { i2c } : {}), devices, ...(imu ? { imu } : {}) };
}

const CMAKE = `cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
project(board_test)
`;

const MAIN_CMAKE = `idf_component_register(SRCS "board_test.c"
                       PRIV_REQUIRES esp_driver_i2c esp_driver_gpio esp_adc spi_flash esp_hw_support)
`;

const KCONFIG = `menu "Kitty board test"

    config KITTY_TEST_I2C_SDA
        int "I2C SDA GPIO (-1 = skip the I2C tests)"
        range -1 48
        default -1

    config KITTY_TEST_I2C_SCL
        int "I2C SCL GPIO"
        range -1 48
        default -1

    config KITTY_TEST_IMU_ADDR
        hex "IMU I2C address (0 = no IMU)"
        range 0 0x77
        default 0

    config KITTY_TEST_IMU_WHOAMI_REG
        hex "IMU WHO_AM_I register"
        range 0 0xff
        default 0x75

    config KITTY_TEST_LOOPBACK_OUT
        int "Loopback output GPIO, wired to the input (-1 = skip)"
        range -1 48
        default -1

    config KITTY_TEST_LOOPBACK_IN
        int "Loopback input GPIO"
        range -1 48
        default -1

    config KITTY_TEST_VBAT_GPIO
        int "ADC GPIO behind a supply divider (-1 = skip)"
        range -1 48
        default -1

    config KITTY_TEST_VBAT_DIVIDER_X100
        int "Divider ratio x100 (200 = halves the voltage)"
        range 100 10000
        default 200

endmenu
`;

/** Prints only Kitty lines and errors, so the log stays readable. */
const SOURCE = `/* Kitty Board Test Firmware ${BOARD_TEST_VERSION}. Generated by Kitty; edit freely.
 * Every result is one JSON line: {"kitty":"metric","name":...,"value":...}
 * Settings: idf.py menuconfig -> Kitty board test, or sdkconfig.defaults. */
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#define BOARD_TEST_VERSION "${BOARD_TEST_VERSION}"

static void metric_int(const char *name, long long value, const char *unit)
{
    if (unit) {
        printf("{\\"kitty\\":\\"metric\\",\\"name\\":\\"%s\\",\\"value\\":%lld,\\"unit\\":\\"%s\\"}\\n", name, value, unit);
    } else {
        printf("{\\"kitty\\":\\"metric\\",\\"name\\":\\"%s\\",\\"value\\":%lld}\\n", name, value);
    }
}

static void metric_str(const char *name, const char *value)
{
    printf("{\\"kitty\\":\\"metric\\",\\"name\\":\\"%s\\",\\"value\\":\\"%s\\"}\\n", name, value);
}

/* Unused when no loopback is configured. */
__attribute__((unused)) static void metric_bool(const char *name, bool value)
{
    printf("{\\"kitty\\":\\"metric\\",\\"name\\":\\"%s\\",\\"value\\":%s}\\n", name, value ? "true" : "false");
}

static const char *chip_model(esp_chip_model_t model)
{
    switch (model) {
    case CHIP_ESP32: return "ESP32";
    case CHIP_ESP32S2: return "ESP32-S2";
    case CHIP_ESP32S3: return "ESP32-S3";
    case CHIP_ESP32C3: return "ESP32-C3";
    case CHIP_ESP32C6: return "ESP32-C6";
    case CHIP_ESP32H2: return "ESP32-H2";
    default: return "unknown";
    }
}

static void test_chip(void)
{
    esp_chip_info_t info;
    esp_chip_info(&info);
    metric_str("chip.model", chip_model(info.model));
    metric_int("chip.revision", info.revision, NULL);
    metric_int("chip.cores", info.cores, NULL);

    uint32_t flash_bytes = 0;
    if (esp_flash_get_size(NULL, &flash_bytes) == ESP_OK) {
        metric_int("flash.size_mb", flash_bytes / (1024 * 1024), "MB");
    }
    metric_int("heap.free_kb", esp_get_free_heap_size() / 1024, "KB");

    uint8_t mac[6];
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        char text[18];
        snprintf(text, sizeof text, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        metric_str("chip.mac", text);
    }
    metric_str("reset.reason", esp_reset_reason() == ESP_RST_POWERON ? "power_on" : "other");
}

static void test_supply(void)
{
#if CONFIG_KITTY_TEST_VBAT_GPIO >= 0
    adc_unit_t unit;
    adc_channel_t channel;
    if (adc_oneshot_io_to_channel(CONFIG_KITTY_TEST_VBAT_GPIO, &unit, &channel) != ESP_OK) {
        metric_str("power.vbat_error", "not an ADC pin");
        return;
    }
    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t unit_config = { .unit_id = unit };
    if (adc_oneshot_new_unit(&unit_config, &adc) != ESP_OK) {
        metric_str("power.vbat_error", "ADC unavailable");
        return;
    }
    adc_oneshot_chan_cfg_t channel_config = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT };
    adc_oneshot_config_channel(adc, channel, &channel_config);
    adc_cali_handle_t cali = NULL;
    adc_cali_curve_fitting_config_t cali_config = {
        .unit_id = unit, .chan = channel, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    bool calibrated = adc_cali_create_scheme_curve_fitting(&cali_config, &cali) == ESP_OK;
    int total_mv = 0;
    for (int i = 0; i < 16; i++) {
        int raw = 0;
        int mv = 0;
        adc_oneshot_read(adc, channel, &raw);
        if (calibrated) {
            adc_cali_raw_to_voltage(cali, raw, &mv);
        } else {
            mv = raw * 3100 / 4095;
        }
        total_mv += mv;
    }
    metric_int("power.vbat_mv", (long long)total_mv / 16 * CONFIG_KITTY_TEST_VBAT_DIVIDER_X100 / 100, "mV");
    if (calibrated) {
        adc_cali_delete_scheme_curve_fitting(cali);
    }
    adc_oneshot_del_unit(adc);
#endif
}

static void test_i2c(void)
{
#if CONFIG_KITTY_TEST_I2C_SDA >= 0 && CONFIG_KITTY_TEST_I2C_SCL >= 0
    i2c_master_bus_config_t bus_config = {
        .i2c_port = -1,
        .sda_io_num = CONFIG_KITTY_TEST_I2C_SDA,
        .scl_io_num = CONFIG_KITTY_TEST_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus;
    if (i2c_new_master_bus(&bus_config, &bus) != ESP_OK) {
        metric_str("i2c.error", "bus init failed");
        return;
    }
    char list[6 * 112 + 3] = "[";
    int count = 0;
    for (uint16_t address = 0x08; address <= 0x77; address++) {
        if (i2c_master_probe(bus, address, 20) == ESP_OK) {
            char item[8];
            snprintf(item, sizeof item, "%s\\"0x%02x\\"", count ? "," : "", address);
            strlcat(list, item, sizeof list);
            count++;
        }
    }
    strlcat(list, "]", sizeof list);
    printf("{\\"kitty\\":\\"metric\\",\\"name\\":\\"i2c.addresses\\",\\"value\\":%s}\\n", list);
    metric_int("i2c.count", count, NULL);

#if CONFIG_KITTY_TEST_IMU_ADDR > 0
    i2c_device_config_t device_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = CONFIG_KITTY_TEST_IMU_ADDR,
        .scl_speed_hz = 100000,
    };
    i2c_master_dev_handle_t imu;
    if (i2c_master_bus_add_device(bus, &device_config, &imu) == ESP_OK) {
        uint8_t reg = CONFIG_KITTY_TEST_IMU_WHOAMI_REG;
        uint8_t id = 0;
        if (i2c_master_transmit_receive(imu, &reg, 1, &id, 1, 100) == ESP_OK) {
            char text[8];
            snprintf(text, sizeof text, "0x%02x", id);
            metric_str("imu.whoami", text);
        } else {
            metric_str("imu.error", "no answer");
        }
        i2c_master_bus_rm_device(imu);
    }
#endif
    i2c_del_master_bus(bus);
#endif
}

static void test_loopback(void)
{
#if CONFIG_KITTY_TEST_LOOPBACK_OUT >= 0 && CONFIG_KITTY_TEST_LOOPBACK_IN >= 0
    gpio_reset_pin(CONFIG_KITTY_TEST_LOOPBACK_OUT);
    gpio_reset_pin(CONFIG_KITTY_TEST_LOOPBACK_IN);
    gpio_set_direction(CONFIG_KITTY_TEST_LOOPBACK_OUT, GPIO_MODE_OUTPUT);
    gpio_set_direction(CONFIG_KITTY_TEST_LOOPBACK_IN, GPIO_MODE_INPUT);
    gpio_set_pull_mode(CONFIG_KITTY_TEST_LOOPBACK_IN, GPIO_FLOATING);
    gpio_set_level(CONFIG_KITTY_TEST_LOOPBACK_OUT, 1);
    vTaskDelay(pdMS_TO_TICKS(5));
    bool high = gpio_get_level(CONFIG_KITTY_TEST_LOOPBACK_IN) == 1;
    gpio_set_level(CONFIG_KITTY_TEST_LOOPBACK_OUT, 0);
    vTaskDelay(pdMS_TO_TICKS(5));
    bool low = gpio_get_level(CONFIG_KITTY_TEST_LOOPBACK_IN) == 0;
    metric_bool("gpio.loopback", high && low);
#endif
}

void app_main(void)
{
    /* Give the host time to open the port after the reset. */
    vTaskDelay(pdMS_TO_TICKS(300));
    printf("{\\"kitty\\":\\"start\\",\\"firmware\\":\\"board-test\\",\\"version\\":\\"%s\\"}\\n", BOARD_TEST_VERSION);
    test_chip();
    test_supply();
    test_i2c();
    test_loopback();
    printf("{\\"kitty\\":\\"end\\"}\\n");
    fflush(stdout);
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`;

/** `esp32s3` → `ESP32-S3`, as the firmware's chip.model reports it. */
const chipModel = (target: string) => target.toUpperCase().replace(/^ESP32(?=[A-Z])/, "ESP32-");

const yamlString = (text: string) => JSON.stringify(text);

/** The generated project and a starting test plan matching what it checks. */
export function boardTestProject(input: {
  readonly product: string;
  readonly target: string;
  readonly firmwareDir: string;
  readonly settings: BoardTestSettings;
}): {
  readonly firmware: Readonly<Record<string, string>>;
  readonly plan: string;
  readonly configured: ReadonlyArray<string>;
} {
  const { settings } = input;
  const defaults = [
    "# Kitty board test settings; see main/Kconfig.projbuild.",
    `CONFIG_IDF_TARGET="${input.target}"`,
    "CONFIG_LOG_DEFAULT_LEVEL_WARN=y",
  ];
  const configured: Array<string> = [];
  if (settings.i2c) {
    defaults.push(
      `CONFIG_KITTY_TEST_I2C_SDA=${settings.i2c.sda}`,
      `CONFIG_KITTY_TEST_I2C_SCL=${settings.i2c.scl}`,
    );
    configured.push(
      `I2C on SDA GPIO${settings.i2c.sda}, SCL GPIO${settings.i2c.scl} (${settings.i2c.from})`,
    );
  }
  if (settings.i2c && settings.imu) {
    defaults.push(
      `CONFIG_KITTY_TEST_IMU_ADDR=${hex(settings.imu.address)}`,
      `CONFIG_KITTY_TEST_IMU_WHOAMI_REG=${hex(settings.imu.register)}`,
    );
    configured.push(
      `IMU ${settings.imu.name} at ${hex(settings.imu.address)}, WHO_AM_I register ${hex(settings.imu.register)}`,
    );
  }

  const cases = [
    `  - id: boot`,
    `    name: Boots and reports its chip`,
    `    metric: chip.model`,
    `    expect: { equals: ${yamlString(chipModel(input.target))} }`,
    `  - id: flash`,
    `    name: Flash detected`,
    `    metric: flash.size_mb`,
    `    expect: { min: 4 }`,
    `  - id: heap`,
    `    name: Free heap`,
    `    metric: heap.free_kb`,
    `    expect: { min: 100 }`,
  ];
  if (settings.i2c) {
    cases.push(
      `  - id: i2c_bus`,
      `    name: Something answers on the I2C bus`,
      `    metric: i2c.count`,
      `    expect: { min: 1 }`,
    );
    for (const device of settings.devices) {
      cases.push(
        `  - id: i2c_${hex(device.address)}`,
        `    name: ${yamlString(`${device.name} answers at ${hex(device.address)}`)}`,
        `    metric: i2c.addresses`,
        `    expect: { contains: "${hex(device.address)}" }`,
      );
    }
  }
  if (settings.i2c && settings.imu) {
    cases.push(
      `  - id: imu_id`,
      `    name: ${yamlString(`${settings.imu.name} identifies itself`)}`,
      `    metric: imu.whoami`,
      settings.imu.id !== undefined
        ? `    expect: { equals: "${hex(settings.imu.id)}" }`
        : `    # Set the WHO_AM_I value from the datasheet, e.g. expect: { equals: "0x68" }`,
    );
  }
  const plan = [
    `# Kitty test plan. Each case names a metric the test firmware prints and the rule it must meet:`,
    `# min / max (numbers), equals, contains (a list or text) and matches (a regular expression).`,
    `schema_version: "0.1"`,
    `name: ${yamlString(`${input.product} board test`)}`,
    `firmware: ${input.firmwareDir}`,
    `timeout_s: 20`,
    `cases:`,
    ...cases,
    ...(settings.i2c
      ? []
      : [
          `  # No I2C pins found in hardware/board.json or the schematic. Set CONFIG_KITTY_TEST_I2C_SDA/SCL`,
          `  # in ${input.firmwareDir}/sdkconfig.defaults, then add a case like:`,
          `  # - id: i2c_bus`,
          `  #   metric: i2c.count`,
          `  #   expect: { min: 1 }`,
        ]),
    `  # A wire between two spare pins (CONFIG_KITTY_TEST_LOOPBACK_OUT/IN) adds gpio.loopback;`,
    `  # a supply divider on an ADC pin (CONFIG_KITTY_TEST_VBAT_GPIO) adds power.vbat_mv.`,
    ``,
  ].join("\n");

  return {
    firmware: {
      "CMakeLists.txt": CMAKE,
      "main/CMakeLists.txt": MAIN_CMAKE,
      "main/Kconfig.projbuild": KCONFIG,
      "main/board_test.c": SOURCE,
      "sdkconfig.defaults": `${defaults.join("\n")}\n`,
    },
    plan,
    configured,
  };
}
