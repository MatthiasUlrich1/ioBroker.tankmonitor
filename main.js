const utils = require('@iobroker/adapter-core');

class Tankmonitor extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'tankmonitor',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.log.info('Tankmonitor adapter started');
        this.log.info('Config: ' + JSON.stringify(this.config));

        // Initialize API managers
        if (this.config.liquidCheck && this.config.liquidCheck.enabled) {
            this.log.info('Initializing LiquidCheck');
        }
        if (this.config.tankinhaltsanzeige && this.config.tankinhaltsanzeige.enabled) {
            this.log.info('Initializing Tankinhaltsanzeige');
        }
        if (this.config.oilview && this.config.oilview.enabled) {
            this.log.info('Initializing Oilview');
        }
    }

    onUnload(callback) {
        try {
            this.log.info('Tankmonitor adapter stopped');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Tankmonitor(options);
} else {
    new Tankmonitor();
}
