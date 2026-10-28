const utils = require('@iobroker/adapter-core');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

// Axios mit Cookie-Jar-Unterstützung wrappen
const axios = wrapper(require('axios'));

/**
 * Oilview API Manager
 * Verwaltet die Kommunikation mit der Oilview API
 */
class OilviewAPI {
    constructor(adapter) {
        this.adapter = adapter;
        this.baseUrl = this.adapter.config['oilview.url'] || 'https://www.oilview.de';
        this.username = this.adapter.config['oilview.username'];
        this.password = this.adapter.config['oilview.password'];
        this.interval = (this.adapter.config['oilview.interval'] || 15) * 60 * 1000; // Minuten zu ms
        this.cookieJar = new CookieJar();
        this.sessionToken = null;
        this.devices = [];
        this.pollInterval = null;
        this.isLoggedIn = false;
    }

    /**
     * Initialisiert den Oilview Client und startet den Polling-Interval
     */
    async init() {
        this.adapter.log.info('[Oilview] Initializing with interval: ' + (this.interval / 60000) + ' minutes');
        try {
            await this.login();
            if (this.isLoggedIn) {
                await this.discoverDevices();
                this.startPolling();
            }
        } catch (e) {
            this.adapter.log.error('[Oilview] Initialisierung fehlgeschlagen: ' + e.message);
        }
    }

    /**
     * Login bei Oilview (Laravel Sanctum / Cookie-basiert)
     * 1. CSRF-Cookie (XSRF-TOKEN) holen
     * 2. POST /api/v2/login mit X-XSRF-TOKEN Header
     */
    async login() {
        try {
            this.adapter.log.info('[Oilview] Logging in...');

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            };

            // Schritt 1: CSRF-Cookie holen (Laravel Sanctum Standard)
            let xsrfToken = null;
            try {
                await axios.get(`${this.baseUrl}/api/v2/csrf-token`, {
                    jar: this.cookieJar,
                    headers
                });
            } catch (e) {
                // Fallback: Startseite holen
                try {
                    await axios.get(this.baseUrl, {
                        jar: this.cookieJar,
                        headers
                    });
                } catch (e2) {
                    this.adapter.log.debug('[Oilview] CSRF-Cookie konnte nicht geladen werden: ' + e2.message);
                }
            }

            // XSRF-TOKEN aus dem Cookie-Jar extrahieren und dekodieren
            const cookiesInJar = await this.cookieJar.getCookies(this.baseUrl);
            const xsrfCookie = cookiesInJar.find(c => c.key === 'XSRF-TOKEN');
            if (xsrfCookie) {
                xsrfToken = decodeURIComponent(xsrfCookie.value);
            }

            // Schritt 2: Login durchführen (JSON)
            const loginPayload = {
                username: this.username,
                password: this.password
            };

            const loginHeaders = { ...headers, 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (xsrfToken) {
                loginHeaders['X-XSRF-TOKEN'] = xsrfToken;
                loginHeaders['X-CSRF-TOKEN'] = xsrfToken;
            }

            const loginResponse = await axios.post(`${this.baseUrl}/api/v2/login`, loginPayload, {
                jar: this.cookieJar,
                headers: loginHeaders,
                maxRedirects: 5,
                validateStatus: status => status < 400
            });

            if (loginResponse.status === 200 || loginResponse.status === 201) {
                this.isLoggedIn = true;
                this.adapter.log.info('[Oilview] Login successful');
            } else {
                throw new Error(`Login failed with status ${loginResponse.status}`);
            }
        } catch (error) {
            this.adapter.log.error(`[Oilview] Login failed: ${error.message}`);
            if (error.response) {
                this.adapter.log.error(`[Oilview] Response status: ${error.response.status}, body: ${JSON.stringify(error.response.data).substring(0, 500)}`);
            }
            this.isLoggedIn = false;
            throw error;
        }
    }

    /**
     * Entdeckt alle verfügbaren Devices
     */
    async discoverDevices() {
        try {
            this.adapter.log.info('[Oilview] Discovering devices...');

            const response = await axios.get(`${this.baseUrl}/api/v2/devices`, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data && Array.isArray(response.data)) {
                this.devices = response.data;
                this.adapter.log.info(`[Oilview] Found ${this.devices.length} device(s)`);

                // States für jedes Device erstellen
                for (const device of this.devices) {
                    await this.createDeviceStates(device);
                }
            } else {
                throw new Error('Unexpected response format from /api/v2/devices');
            }
        } catch (error) {
            this.adapter.log.error(`[Oilview] Device discovery failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Erstellt ioBroker States für ein Device
     */
    async createDeviceStates(device) {
        const deviceId = device.id || device.deviceId || `device_${device.name || 'unknown'}`;
        const devicePath = `oilview.${deviceId}`;

        this.adapter.log.debug(`[Oilview] Creating states for device: ${deviceId}`);

        // Device-Ordner erstellen
        this.adapter.log.debug('[Oilview] Creating device channel object: ' + devicePath);
        await this.adapter.extendObjectAsync(devicePath, {
            type: 'channel',
            common: {
                name: device.name || deviceId
            },
            native: {}
        });
        this.adapter.log.debug('[Oilview] Created device channel object: ' + devicePath);

        // Standard-States erstellen
        const states = [
            { id: 'levelPercent', name: 'Füllstand (%)', type: 'number', unit: '%' },
            { id: 'levelLiters', name: 'Füllstand (Liter)', type: 'number', unit: 'l' },
            { id: 'temperature', name: 'Temperatur', type: 'number', unit: '°C' },
            { id: 'battery', name: 'Batterie', type: 'number', unit: '%' },
            { id: 'signalStrength', name: 'Signalstärke', type: 'number', unit: '%' },
            { id: 'lastUpdate', name: 'Letztes Update', type: 'string' },
            { id: 'deviceName', name: 'Gerätename', type: 'string' }
        ];

        for (const state of states) {
            this.adapter.log.debug(`[Oilview] Creating state: ${devicePath}.${state.id}`);
            await this.adapter.extendObjectAsync(`${devicePath}.${state.id}`, {
                type: 'state',
                common: {
                    name: state.name,
                    type: state.type,
                    role: 'value',
                    unit: state.unit,
                    read: true,
                    write: false
                },
                native: {}
            });
            this.adapter.log.debug(`[Oilview] Created state: ${devicePath}.${state.id}`);
        }
    }

    /**
     * Holt Sensordaten für alle Devices
     */
    async fetchSensorData() {
        try {
            this.adapter.log.debug('[Oilview] Fetching sensor data...');

            const response = await axios.get(`${this.baseUrl}/api/v2/sensor-data`, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data) {
                // Daten für jedes Device aktualisieren
                for (const device of this.devices) {
                    const deviceId = device.id || device.deviceId || `device_${device.name || 'unknown'}`;
                    const deviceData = Array.isArray(response.data)
                        ? response.data.find(d => d.deviceId === deviceId || d.id === deviceId)
                        : response.data;

                    if (deviceData) {
                        await this.updateDeviceStates(deviceId, deviceData);
                    }
                }
            }
        } catch (error) {
            this.adapter.log.error(`[Oilview] Sensor data fetch failed: ${error.message}`);

            // Bei 401 Fehler: Re-Login versuchen
            if (error.response && error.response.status === 401) {
                this.adapter.log.warn('[Oilview] Session expired, attempting re-login...');
                this.isLoggedIn = false;
                await this.login();
                if (this.isLoggedIn) {
                    await this.fetchSensorData(); // Retry
                }
            }
            throw error;
        }
    }

    /**
     * Aktualisiert die States für ein Device
     */
    async updateDeviceStates(deviceId, data) {
        const devicePath = `oilview.${deviceId}`;

        try {
            this.adapter.log.debug(`[Oilview] Updating states for device: ${deviceId}`);
            
            const stateUpdates = [
                { id: 'levelPercent', val: data.levelPercent || data.level_percent || null },
                { id: 'levelLiters', val: data.levelLiters || data.level_liters || data.volume || null },
                { id: 'temperature', val: data.temperature || data.temp || null },
                { id: 'battery', val: data.battery || data.batteryLevel || null },
                { id: 'signalStrength', val: data.signalStrength || data.signal_strength || data.rssi || null },
                { id: 'lastUpdate', val: new Date().toISOString() },
                { id: 'deviceName', val: data.name || deviceId }
            ];

            for (const update of stateUpdates) {
                await this.adapter.setStateAsync(`${devicePath}.${update.id}`, {
                    val: update.val,
                    ack: true
                });
            }

            this.adapter.log.debug(`[Oilview] Updated states for device ${deviceId}`);
        } catch (error) {
            this.adapter.log.error(`[Oilview] Failed to update states for ${deviceId}: ${error.message}`);
        }
    }

    /**
     * Startet den Polling-Interval
     */
    startPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }

        this.pollInterval = setInterval(async () => {
            try {
                await this.fetchSensorData();
            } catch (error) {
                this.adapter.log.error(`[Oilview] Polling error: ${error.message}`);
            }
        }, this.interval);

        this.adapter.log.info(`[Oilview] Polling started with interval ${this.interval / 60000} minutes`);
    }

    /**
     * Stoppt den Polling-Interval
     */
    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.adapter.log.info('[Oilview] Polling stopped');
    }
}

/**
 * Tankinhaltsanzeige API Manager
 * Verwaltet die Kommunikation mit der Tankinhaltsanzeige API
 */
class TankinhaltsanzeigeAPI {
    constructor(adapter) {
        this.adapter = adapter;
        this.baseUrl = this.adapter.config['tankinhaltsanzeige.url'] || 'https://www.tankinhaltsanzeige.de';
        this.username = this.adapter.config['tankinhaltsanzeige.username'];
        this.password = this.adapter.config['tankinhaltsanzeige.password'];
        this.interval = (this.adapter.config['tankinhaltsanzeige.interval'] || 30) * 60 * 1000;
        this.cookieJar = new CookieJar();
        this.sessionToken = null;
        this.stations = [];
        this.pollInterval = null;
        this.isLoggedIn = false;
    }

    /**
     * Initialisiert den Client und startet das Polling
     */
    async init() {
        this.adapter.log.info('[Tankinhaltsanzeige] Initializing with interval: ' + (this.interval / 60000) + ' minutes');
        try {
            await this.login();
            if (this.isLoggedIn) {
                await this.discoverStations();
                this.startPolling();
            }
        } catch (e) {
            this.adapter.log.error('[Tankinhaltsanzeige] Initialisierung fehlgeschlagen: ' + e.message);
        }
    }

    /**
     * Login mit CSRF-Token-Extraktion
     */
    async login() {
        try {
            this.adapter.log.info('[Tankinhaltsanzeige] Logging in...');

            // Schritt 1: Login-Seite holen und CSRF-Token extrahieren
            const loginPageResponse = await axios.get(`${this.baseUrl}/auth/login`, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            // CSRF-Token aus HTML extrahieren (verschiedene mögliche Formate)
            let csrfToken = null;

            // Format 1: <meta name="csrf-token" content="...">
            const metaMatch = loginPageResponse.data.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
            if (metaMatch) {
                csrfToken = metaMatch[1];
            }

            // Format 2: <input type="hidden" name="_csrf" value="...">
            if (!csrfToken) {
                const inputMatch = loginPageResponse.data.match(/name="_csrf"\s+value="([^"]+)"/i);
                if (inputMatch) {
                    csrfToken = inputMatch[1];
                }
            }

            // Format 3: JavaScript-Variable
            if (!csrfToken) {
                const jsMatch = loginPageResponse.data.match(/csrfToken\s*[:=]\s*['"]([^'"]+)['"]/i);
                if (jsMatch) {
                    csrfToken = jsMatch[1];
                }
            }

            if (!csrfToken) {
                this.adapter.log.warn('[Tankinhaltsanzeige] CSRF-Token nicht gefunden, versuche Login ohne Token');
            } else {
                this.adapter.log.debug('[Tankinhaltsanzeige] CSRF-Token extrahiert');
            }

            // Schritt 2: Login durchführen
            const loginData = {
                email: this.username,
                password: this.password
            };

            if (csrfToken) {
                loginData._csrf = csrfToken;
            }

            const loginResponse = await axios.post(`${this.baseUrl}/auth/login`, loginData, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (loginResponse.status === 200 || loginResponse.status === 302 || loginResponse.status === 201) {
                this.isLoggedIn = true;
                this.adapter.log.info('[Tankinhaltsanzeige] Login successful');
            } else {
                throw new Error(`Login failed with status ${loginResponse.status}`);
            }
        } catch (error) {
            this.adapter.log.error(`[Tankinhaltsanzeige] Login failed: ${error.message}`);
            this.isLoggedIn = false;
            throw error;
        }
    }

    /**
     * Entdeckt alle verfügbaren Stationen
     */
    async discoverStations() {
        try {
            this.adapter.log.info('[Tankinhaltsanzeige] Discovering stations...');

            const response = await axios.get(`${this.baseUrl}/api/stationen`, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data && Array.isArray(response.data)) {
                this.stations = response.data;
                this.adapter.log.info(`[Tankinhaltsanzeige] Found ${this.stations.length} station(s)`);

                // States für jede Station erstellen
                for (const station of this.stations) {
                    await this.createStationStates(station);
                }
            } else {
                throw new Error('Unexpected response format from /api/stationen');
            }
        } catch (error) {
            this.adapter.log.error(`[Tankinhaltsanzeige] Station discovery failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Erstellt ioBroker States für eine Station
     */
    async createStationStates(station) {
        const stationId = station.id || station.stationId || `station_${station.name || 'unknown'}`;
        const stationPath = `tankinhaltsanzeige.${stationId}`;

        this.adapter.log.debug(`[Tankinhaltsanzeige] Creating states for station: ${stationId}`);

        // Station-Ordner erstellen
        this.adapter.log.debug('[Tankinhaltsanzeige] Creating station channel object: ' + stationPath);
        await this.adapter.extendObjectAsync(stationPath, {
            type: 'channel',
            common: {
                name: station.name || stationId
            },
            native: {}
        });
        this.adapter.log.debug('[Tankinhaltsanzeige] Created station channel object: ' + stationPath);

        // Standard-States erstellen
        const states = [
            { id: 'levelPercent', name: 'Füllstand (%)', type: 'number', unit: '%' },
            { id: 'levelLiters', name: 'Füllstand (Liter)', type: 'number', unit: 'l' },
            { id: 'volumeMax', name: 'Maximales Volumen', type: 'number', unit: 'l' },
            { id: 'temperature', name: 'Temperatur', type: 'number', unit: '°C' },
            { id: 'battery', name: 'Batterie', type: 'number', unit: '%' },
            { id: 'signalStrength', name: 'Signalstärke', type: 'number', unit: '%' },
            { id: 'lastUpdate', name: 'Letztes Update', type: 'string' },
            { id: 'stationName', name: 'Stationsname', type: 'string' }
        ];

        for (const state of states) {
            this.adapter.log.debug(`[Tankinhaltsanzeige] Creating state: ${stationPath}.${state.id}`);
            await this.adapter.extendObjectAsync(`${stationPath}.${state.id}`, {
                type: 'state',
                common: {
                    name: state.name,
                    type: state.type,
                    role: 'value',
                    unit: state.unit,
                    read: true,
                    write: false
                },
                native: {}
            });
            this.adapter.log.debug(`[Tankinhaltsanzeige] Created state: ${stationPath}.${state.id}`);
        }
    }

    /**
     * Holt Daten für alle Stationen
     */
    async fetchStationData() {
        try {
            this.adapter.log.debug('[Tankinhaltsanzeige] Fetching station data...');

            // Aktuelle Daten von der API holen
            const response = await axios.get(`${this.baseUrl}/api/stationen`, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data && Array.isArray(response.data)) {
                for (const station of response.data) {
                    const stationId = station.id || station.stationId || `station_${station.name || 'unknown'}`;
                    await this.updateStationStates(stationId, station);
                }
            }
        } catch (error) {
            this.adapter.log.error(`[Tankinhaltsanzeige] Station data fetch failed: ${error.message}`);

            // Bei 401 Fehler: Re-Login versuchen
            if (error.response && error.response.status === 401) {
                this.adapter.log.warn('[Tankinhaltsanzeige] Session expired, attempting re-login...');
                this.isLoggedIn = false;
                await this.login();
                if (this.isLoggedIn) {
                    await this.fetchStationData(); // Retry
                }
            }
            throw error;
        }
    }

    /**
     * Aktualisiert die States für eine Station
     */
    async updateStationStates(stationId, data) {
        const stationPath = `tankinhaltsanzeige.${stationId}`;

        try {
            this.adapter.log.debug(`[Tankinhaltsanzeige] Updating states for station: ${stationId}`);

            const stateUpdates = [
                { id: 'levelPercent', val: data.levelPercent || data.fuellstandProzent || data.fillLevelPercent || null },
                { id: 'levelLiters', val: data.levelLiters || data.fuellstandLiter || data.fillLevelLiters || data.volume || null },
                { id: 'volumeMax', val: data.volumeMax || data.maxVolume || data.maxVolumen || null },
                { id: 'temperature', val: data.temperature || data.temp || null },
                { id: 'battery', val: data.battery || data.batteryLevel || null },
                { id: 'signalStrength', val: data.signalStrength || data.signal || data.rssi || null },
                { id: 'lastUpdate', val: new Date().toISOString() },
                { id: 'stationName', val: data.name || stationId }
            ];

            for (const update of stateUpdates) {
                await this.adapter.setStateAsync(`${stationPath}.${update.id}`, {
                    val: update.val,
                    ack: true
                });
            }

            this.adapter.log.debug(`[Tankinhaltsanzeige] Updated states for station ${stationId}`);
        } catch (error) {
            this.adapter.log.error(`[Tankinhaltsanzeige] Failed to update states for ${stationId}: ${error.message}`);
        }
    }

    /**
     * Startet den Polling-Interval
     */
    startPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }

        this.pollInterval = setInterval(async () => {
            try {
                await this.fetchStationData();
            } catch (error) {
                this.adapter.log.error(`[Tankinhaltsanzeige] Polling error: ${error.message}`);
            }
        }, this.interval);

        this.adapter.log.info(`[Tankinhaltsanzeige] Polling started with interval ${this.interval / 60000} minutes`);
    }

    /**
     * Stoppt den Polling-Interval
     */
    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.adapter.log.info('[Tankinhaltsanzeige] Polling stopped');
    }
}

/**
 * LiquidCheck (Grafana) API Manager
 * Verwaltet die Kommunikation mit der Grafana API
 */
class LiquidCheckAPI {
    constructor(adapter) {
        this.adapter = adapter;
        this.baseUrl = this.adapter.config['liquidCheck.url'] || 'https://liquidcheck.si-elektronik.de';
        this.username = this.adapter.config['liquidCheck.username'];
        this.password = this.adapter.config['liquidCheck.password'];
        this.interval = (this.adapter.config['liquidCheck.interval'] || 5) * 60 * 1000;
        this.cookieJar = new CookieJar();
        this.apiKey = null;
        this.dashboards = [];
        this.pollInterval = null;
        this.isLoggedIn = false;
    }

    /**
     * Initialisiert den Client und startet das Polling
     */
    async init() {
        this.adapter.log.info('[LiquidCheck] Initializing with interval: ' + (this.interval / 60000) + ' minutes');
        try {
            await this.login();
            if (this.isLoggedIn) {
                await this.discoverDashboards();
                this.startPolling();
            }
        } catch (e) {
            this.adapter.log.error('[LiquidCheck] Initialisierung fehlgeschlagen: ' + e.message);
        }
    }

    /**
     * Login bei Grafana
     */
    async login() {
        try {
            this.adapter.log.info('[LiquidCheck] Logging in...');

            const loginResponse = await axios.post(`${this.baseUrl}/api/login`, {
                user: this.username,
                password: this.password
            }, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (loginResponse.status === 200) {
                this.isLoggedIn = true;
                this.adapter.log.info('[LiquidCheck] Login successful');

                // API-Key aus der Session extrahieren (falls verfügbar)
                if (loginResponse.data && loginResponse.data.apiKey) {
                    this.apiKey = loginResponse.data.apiKey;
                }
            } else {
                throw new Error(`Login failed with status ${loginResponse.status}`);
            }
        } catch (error) {
            this.adapter.log.error(`[LiquidCheck] Login failed: ${error.message}`);
            this.isLoggedIn = false;
            throw error;
        }
    }

    /**
     * Entdeckt alle verfügbaren Dashboards
     */
    async discoverDashboards() {
        try {
            this.adapter.log.info('[LiquidCheck] Discovering dashboards...');

            const response = await axios.get(`${this.baseUrl}/api/search?type=dash`, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data && Array.isArray(response.data)) {
                this.dashboards = response.data;
                this.adapter.log.info(`[LiquidCheck] Found ${this.dashboards.length} dashboard(s)`);

                // States für jedes Dashboard erstellen
                for (const dashboard of this.dashboards) {
                    await this.createDashboardStates(dashboard);
                }
            } else {
                throw new Error('Unexpected response format from /api/search');
            }
        } catch (error) {
            this.adapter.log.error(`[LiquidCheck] Dashboard discovery failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Erstellt ioBroker States für ein Dashboard
     */
    async createDashboardStates(dashboard) {
        const dashboardId = dashboard.uid || dashboard.id || `dash_${dashboard.title || 'unknown'}`;
        const dashboardPath = `liquidcheck.${dashboardId}`;

        this.adapter.log.debug(`[LiquidCheck] Creating states for dashboard: ${dashboardId}`);

        // Dashboard-Ordner erstellen
        this.adapter.log.debug('[LiquidCheck] Creating dashboard channel object: ' + dashboardPath);
        await this.adapter.extendObjectAsync(dashboardPath, {
            type: 'channel',
            common: {
                name: dashboard.title || dashboardId
            },
            native: {}
        });
        this.adapter.log.debug('[LiquidCheck] Created dashboard channel object: ' + dashboardPath);

        // Standard-States erstellen
        const states = [
            { id: 'levelPercent', name: 'Füllstand (%)', type: 'number', unit: '%' },
            { id: 'levelLiters', name: 'Füllstand (Liter)', type: 'number', unit: 'l' },
            { id: 'volumeMax', name: 'Maximales Volumen', type: 'number', unit: 'l' },
            { id: 'temperature', name: 'Temperatur', type: 'number', unit: '°C' },
            { id: 'lastUpdate', name: 'Letztes Update', type: 'string' },
            { id: 'dashboardName', name: 'Dashboard-Name', type: 'string' }
        ];

        for (const state of states) {
            this.adapter.log.debug(`[LiquidCheck] Creating state: ${dashboardPath}.${state.id}`);
            await this.adapter.extendObjectAsync(`${dashboardPath}.${state.id}`, {
                type: 'state',
                common: {
                    name: state.name,
                    type: state.type,
                    role: 'value',
                    unit: state.unit,
                    read: true,
                    write: false
                },
                native: {}
            });
            this.adapter.log.debug(`[LiquidCheck] Created state: ${dashboardPath}.${state.id}`);
        }
    }

    /**
     * Holt Daten aus allen Dashboards
     */
    async fetchDashboardData() {
        try {
            this.adapter.log.debug('[LiquidCheck] Fetching dashboard data...');

            for (const dashboard of this.dashboards) {
                const dashboardId = dashboard.uid || dashboard.id;

                // Dashboard-Details holen
                const dashboardResponse = await axios.get(`${this.baseUrl}/api/dashboards/uid/${dashboardId}`, {
                    jar: this.cookieJar,
                    withCredentials: true,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                if (dashboardResponse.data && dashboardResponse.data.dashboard) {
                    // Panels aus dem Dashboard extrahieren
                    const panels = dashboardResponse.data.dashboard.panels || [];

                    // Für jedes Panel die Daten holen
                    for (const panel of panels) {
                        if (panel.targets && panel.targets.length > 0) {
                            // Query an die DataSource senden
                            await this.fetchPanelData(dashboardId, panel);
                        }
                    }
                }
            }
        } catch (error) {
            this.adapter.log.error(`[LiquidCheck] Dashboard data fetch failed: ${error.message}`);

            // Bei 401 Fehler: Re-Login versuchen
            if (error.response && error.response.status === 401) {
                this.adapter.log.warn('[LiquidCheck] Session expired, attempting re-login...');
                this.isLoggedIn = false;
                await this.login();
                if (this.isLoggedIn) {
                    await this.fetchDashboardData(); // Retry
                }
            }
            throw error;
        }
    }

    /**
     * Holt Daten für ein einzelnes Panel
     */
    async fetchPanelData(dashboardId, panel) {
        try {
            const queryPayload = {
                queries: panel.targets.map(target => ({
                    refId: target.refId || 'A',
                    datasourceId: target.datasourceId,
                    panelId: panel.id,
                    dashboardId: dashboardId,
                    ...target
                })),
                from: Date.now() - 3600000, // Letzte Stunde
                to: Date.now(),
                interval: '5m'
            };

            const response = await axios.post(`${this.baseUrl}/api/ds/query`, queryPayload, {
                jar: this.cookieJar,
                withCredentials: true,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data && response.data.results) {
                // Daten aus den Query-Ergebnissen extrahieren
                for (const [refId, result] of Object.entries(response.data.results)) {
                    if (result.frames && result.frames.length > 0) {
                        const frame = result.frames[0];
                        if (frame.fields && frame.fields.length > 0) {
                            // Werte aus dem DataFrame extrahieren
                            const values = frame.fields[0].values || [];
                            if (values.length > 0) {
                                const latestValue = values[values.length - 1];
                                await this.updateDashboardValue(dashboardId, panel.title || refId, latestValue);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            this.adapter.log.debug(`[LiquidCheck] Panel data fetch failed for ${panel.title}: ${error.message}`);
        }
    }

    /**
     * Aktualisiert einen Dashboard-Wert
     */
    async updateDashboardValue(dashboardId, panelName, value) {
        const dashboardPath = `liquidcheck.${dashboardId}`;
        const safePanelName = panelName.replace(/[^a-zA-Z0-9_]/g, '_');

        try {
            this.adapter.log.debug(`[LiquidCheck] Updating value for ${dashboardId}.${safePanelName}`);
            
            // State erstellen falls nicht vorhanden
            await this.adapter.extendObjectAsync(`${dashboardPath}.${safePanelName}`, {
                type: 'state',
                common: {
                    name: panelName,
                    type: 'number',
                    role: 'value',
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.adapter.setStateAsync(`${dashboardPath}.${safePanelName}`, {
                val: value,
                ack: true
            });

            // Hauptwerte aktualisieren (wenn es sich um Füllstand handelt)
            if (panelName.toLowerCase().includes('füllstand') || panelName.toLowerCase().includes('level')) {
                if (typeof value === 'number') {
                    if (value <= 100) {
                        await this.adapter.setStateAsync(`${dashboardPath}.levelPercent`, {
                            val: value,
                            ack: true
                        });
                    } else {
                        await this.adapter.setStateAsync(`${dashboardPath}.levelLiters`, {
                            val: value,
                            ack: true
                        });
                    }
                }
            }

            await this.adapter.setStateAsync(`${dashboardPath}.lastUpdate`, {
                val: new Date().toISOString(),
                ack: true
            });

            await this.adapter.setStateAsync(`${dashboardPath}.dashboardName`, {
                val: dashboardId,
                ack: true
            });

            this.adapter.log.debug(`[LiquidCheck] Updated ${dashboardId}.${safePanelName} = ${value}`);
        } catch (error) {
            this.adapter.log.error(`[LiquidCheck] Failed to update ${dashboardId}.${safePanelName}: ${error.message}`);
        }
    }

    /**
     * Startet den Polling-Interval
     */
    startPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }

        this.pollInterval = setInterval(async () => {
            try {
                await this.fetchDashboardData();
            } catch (error) {
                this.adapter.log.error(`[LiquidCheck] Polling error: ${error.message}`);
            }
        }, this.interval);

        this.adapter.log.info(`[LiquidCheck] Polling started with interval ${this.interval / 60000} minutes`);
    }

    /**
     * Stoppt den Polling-Interval
     */
    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.adapter.log.info('[LiquidCheck] Polling stopped');
    }
}

/**
 * Haupt-Adapter-Klasse
 */
class Tankmonitor extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'tankmonitor',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // API-Manager Instanzen
        this.oilviewAPI = null;
        this.tankinhaltsanzeigeAPI = null;
        this.liquidCheckAPI = null;
    }

    async onReady() {
        this.log.info('Tankmonitor adapter starting...');
        this.log.info('Configuration: ' + JSON.stringify(this.config, null, 2));

        try {
            // Oilview initialisieren
            if (this.config['oilview.enabled']) {
                try {
                    this.log.info('Initializing Oilview API...');
                    this.oilviewAPI = new OilviewAPI(this);
                    await this.oilviewAPI.init();
                } catch (e) {
                    this.log.error('Failed to initialize Oilview: ' + e.message);
                }
            } else {
                this.log.debug('Oilview is disabled in configuration');
            }

            // Tankinhaltsanzeige initialisieren
            if (this.config['tankinhaltsanzeige.enabled']) {
                try {
                    this.log.info('Initializing Tankinhaltsanzeige API...');
                    this.tankinhaltsanzeigeAPI = new TankinhaltsanzeigeAPI(this);
                    await this.tankinhaltsanzeigeAPI.init();
                } catch (e) {
                    this.log.error('Failed to initialize Tankinhaltsanzeige: ' + e.message);
                }
            } else {
                this.log.debug('Tankinhaltsanzeige is disabled in configuration');
            }

            // LiquidCheck initialisieren
            if (this.config['liquidCheck.enabled']) {
                try {
                    this.log.info('Initializing LiquidCheck API...');
                    this.liquidCheckAPI = new LiquidCheckAPI(this);
                    await this.liquidCheckAPI.init();
                } catch (e) {
                    this.log.error('Failed to initialize LiquidCheck: ' + e.message);
                }
            } else {
                this.log.debug('LiquidCheck is disabled in configuration');
            }

            this.log.info('Tankmonitor adapter successfully started');
        } catch (error) {
            this.log.error('Failed to initialize Tankmonitor adapter: ' + error.message);
            this.log.error(error.stack);
        }
    }

    onUnload(callback) {
        try {
            this.log.info('Tankmonitor adapter stopping...');

            // Alle Polling-Intervalle stoppen
            if (this.oilviewAPI) {
                this.oilviewAPI.stop();
            }
            if (this.tankinhaltsanzeigeAPI) {
                this.tankinhaltsanzeigeAPI.stop();
            }
            if (this.liquidCheckAPI) {
                this.liquidCheckAPI.stop();
            }

            this.log.info('Tankmonitor adapter stopped gracefully');
            callback();
        } catch (e) {
            this.log.error('Error during adapter unload: ' + e.message);
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Tankmonitor(options);
} else {
    new Tankmonitor();
}