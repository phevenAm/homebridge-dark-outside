"use strict";
// Dark Outside for Homebridge. Single file, no build step needed.

// ---- Light data ----
fetchLight = fetchLight;
luxAt = luxAt;
decideDark = decideDark;
/** Rough conversion from sunlight power (W/m²) to brightness (lux). Daylight is about 120 lux per W/m². */
const LUX_PER_WM2 = 120;
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
/** Fetches sunlight for the last 30 minutes and next 30 minutes, in 15-minute steps. */
async function fetchLight(lat, lon, baseUrl = OPEN_METEO_URL) {
    const url = `${baseUrl}?latitude=${lat}&longitude=${lon}`
        + '&minutely_15=shortwave_radiation_instant&past_minutely_15=2&forecast_minutely_15=3&timeformat=unixtime';
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'homebridge-dark-outside' } });
    if (!res.ok) {
        throw new Error(`Open-Meteo returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const times = data.minutely_15?.time ?? [];
    const values = data.minutely_15?.shortwave_radiation_instant ?? [];
    const samples = [];
    times.forEach((t, i) => {
        const v = values[i];
        if (typeof v === 'number' && Number.isFinite(v)) {
            samples.push({ time: t, wm2: Math.max(0, v) });
        }
    });
    if (samples.length === 0) {
        throw new Error('Open-Meteo sent no sunlight data');
    }
    return samples.sort((a, b) => a.time - b.time);
}
/** Light level now, in lux, blending between the two nearest 15-minute steps. */
function luxAt(samples, nowSec) {
    if (samples.length === 0) {
        return undefined;
    }
    if (nowSec <= samples[0].time) {
        return samples[0].wm2 * LUX_PER_WM2;
    }
    for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        if (nowSec >= a.time && nowSec <= b.time) {
            const f = (nowSec - a.time) / (b.time - a.time);
            return (a.wm2 + (b.wm2 - a.wm2) * f) * LUX_PER_WM2;
        }
    }
    const last = samples[samples.length - 1];
    // Data too old (over 30 minutes past the last step): don't guess.
    return nowSec - last.time <= 1800 ? last.wm2 * LUX_PER_WM2 : undefined;
}
/** Dark below the dark level; light again only above the light level. In between, keep the last state. */
function decideDark(lux, wasDark, darkBelow, lightAbove) {
    if (lux < darkBelow) {
        return true;
    }
    if (lux > lightAbove) {
        return false;
    }
    return wasDark;
}
//# sourceMappingURL=light.js.map
// ---- Homebridge platform ----
const PLATFORM_NAME = 'DarkOutside';
const PLUGIN_NAME = 'homebridge-dark-outside';
class DarkOutsidePlatform {
    log;
    config;
    api;
    accessory;
    samples = [];
    dark = false;
    lastLoggedLux;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        api.on('didFinishLaunching', () => void this.start());
    }
    configureAccessory(accessory) {
        this.accessory = accessory;
    }
    get darkBelow() {
        return Math.max(1, Number(this.config.darkBelowLux ?? 300));
    }
    get lightAbove() {
        const set = Number(this.config.lightAboveLux);
        return Number.isFinite(set) && set > this.darkBelow ? set : this.darkBelow * 1.5;
    }
    async start() {
        const { latitude, longitude } = this.config;
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
            this.log.error('Please add your latitude and longitude in the Dark Outside settings.');
            return;
        }
        this.setupAccessory();
        this.dark = this.readState();
        this.log.info(`Dark below ${this.darkBelow} lux, light again above ${Math.round(this.lightAbove)} lux.`);
        await this.refresh();
        const minutes = Math.max(5, Number(this.config.refreshMinutes ?? 10));
        setInterval(() => void this.refresh(), minutes * 60_000);
        setInterval(() => this.update(false), 60_000);
    }
    setupAccessory() {
        const { Service, Characteristic } = this.api.hap;
        const name = this.config.name || 'Dark outside';
        const uuid = this.api.hap.uuid.generate('dark-outside');
        if (!this.accessory) {
            this.accessory = new this.api.platformAccessory(name, uuid);
            this.accessory.addService(Service.OccupancySensor, name);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
        }
        this.accessory.getService(Service.AccessoryInformation)
            ?.setCharacteristic(Characteristic.Manufacturer, 'Dark Outside')
            .setCharacteristic(Characteristic.Model, 'Open-Meteo light sensor')
            .setCharacteristic(Characteristic.SerialNumber, uuid.slice(0, 8));
    }
    service() {
        return this.accessory?.getService(this.api.hap.Service.OccupancySensor);
    }
    readState() {
        const C = this.api.hap.Characteristic.OccupancyDetected;
        return this.service()?.getCharacteristic(C).value === C.OCCUPANCY_DETECTED;
    }
    async refresh() {
        try {
            this.samples = await (fetchLight)(this.config.latitude, this.config.longitude, this.config.apiUrl || OPEN_METEO_URL);
            this.update(true);
        }
        catch (err) {
            this.log.warn(`Couldn't get light data: ${err instanceof Error ? err.message : String(err)}. Keeping the last state.`);
        }
    }
    update(logLevel) {
        const lux = (luxAt)(this.samples, Date.now() / 1000);
        if (lux === undefined) {
            return; // no fresh data: keep the last state rather than guess
        }
        const now = (decideDark)(lux, this.dark, this.darkBelow, this.lightAbove);
        const C = this.api.hap.Characteristic.OccupancyDetected;
        this.service()?.updateCharacteristic(C, now ? C.OCCUPANCY_DETECTED : C.OCCUPANCY_NOT_DETECTED);
        if (now !== this.dark) {
            this.log.info(`${now ? 'Dark' : 'Light'} outside now (${Math.round(lux)} lux).`);
        }
        else if (logLevel && lux !== this.lastLoggedLux) {
            this.log.info(`Light level: ${Math.round(lux)} lux (${now ? 'dark' : 'light'}).`);
        }
        this.lastLoggedLux = lux;
        this.dark = now;
    }
}

//# sourceMappingURL=platform.js.map
module.exports = (api) => {
    api.registerPlatform(PLATFORM_NAME, DarkOutsidePlatform);
};
module.exports.decideDark = decideDark;
module.exports.luxAt = luxAt;
module.exports.fetchLight = fetchLight;
