if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('SW registered'))
        .catch(err => console.warn('SW registration failed:', err));
}

const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const DIS_CHARS = {
    manufacturer: '00002a29-0000-1000-8000-00805f9b34fb',
    firmware: '00002a26-0000-1000-8000-00805f9b34fb',
    hardware: '00002a27-0000-1000-8000-00805f9b34fb',
    software: '00002a28-0000-1000-8000-00805f9b34fb'
};
const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';
const MYO_ROVER_UUID = '66375178-6231-3937-1258-432199739bcc';
const MYO_ROVER_INPUT_UUID = '78153469-6274-3432-9825-72538293bb02';
const SERIAL_NUMBER_RESERVE_SERVICE = '0000ffe1-0000-1000-8000-00805f9b34fb';
const SERIAL_NUMBER_RESERVE_CHARACTERISTIC = '0000ffe2-0000-1000-8000-00805f9b34fb';

const SEND_INTERVAL_MS = 80;

let device = null;
let server = null;
let inputCharacteristic = null;
let sendTimer = null;
let writeInFlight = false;
let pendingPayload = null;

let m1 = 0;
let m2 = 0;

const connectBtn = document.getElementById('connectBtn');
const stopBtn = document.getElementById('stopBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusDiv = document.getElementById('status');
const m1Slider = document.getElementById('m1Slider');
const m2Slider = document.getElementById('m2Slider');
const m1Value = document.getElementById('m1Value');
const m2Value = document.getElementById('m2Value');

connectBtn.addEventListener('click', connectDevice);
stopBtn.addEventListener('click', stopMotors);
disconnectBtn.addEventListener('click', disconnectDevice);
m1Slider.addEventListener('input', () => onSliderChange('m1', m1Slider, m1Value));
m2Slider.addEventListener('input', () => onSliderChange('m2', m2Slider, m2Value));

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopMotors();
    }
});

window.addEventListener('pagehide', () => {
    stopMotors();
});

function onSliderChange(motor, slider, label) {
    const value = clampMotor(slider.value);
    if (motor === 'm1') {
        m1 = value;
    } else {
        m2 = value;
    }
    label.textContent = String(value);
}

function clampMotor(value) {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) {
        return 0;
    }
    return Math.max(-100, Math.min(100, n));
}

function setControlsEnabled(enabled) {
    m1Slider.disabled = !enabled;
    m2Slider.disabled = !enabled;
    stopBtn.disabled = !enabled;
    disconnectBtn.disabled = !enabled;
    connectBtn.disabled = enabled;
}

function resetMotorUi() {
    m1 = 0;
    m2 = 0;
    m1Slider.value = '0';
    m2Slider.value = '0';
    m1Value.textContent = '0';
    m2Value.textContent = '0';
}

function stopMotors() {
    resetMotorUi();
    sendMotorCommand(0, 0);
}

function startSendLoop() {
    stopSendLoop();
    sendTimer = setInterval(() => {
        sendMotorCommand(m1, m2);
    }, SEND_INTERVAL_MS);
    sendMotorCommand(m1, m2);
}

function stopSendLoop() {
    if (sendTimer !== null) {
        clearInterval(sendTimer);
        sendTimer = null;
    }
}

async function sendMotorCommand(left, right) {
    const payload = new Int8Array([clampMotor(left), clampMotor(right)]);
    if (!inputCharacteristic) {
        return;
    }
    if (writeInFlight) {
        pendingPayload = payload;
        return;
    }

    writeInFlight = true;
    try {
        if (inputCharacteristic.properties.writeWithoutResponse) {
            await inputCharacteristic.writeValueWithoutResponse(payload);
        } else {
            await inputCharacteristic.writeValue(payload);
        }
    } catch (error) {
        console.error('Ошибка записи команды моторов:', error);
        statusDiv.textContent = 'Ошибка отправки: ' + error.message;
    } finally {
        writeInFlight = false;
        if (pendingPayload) {
            const next = pendingPayload;
            pendingPayload = null;
            sendMotorCommand(next[0], next[1]);
        }
    }
}

async function connectDevice() {
    try {
        device = await navigator.bluetooth.requestDevice({
            filters: [
                { services: [MYO_ROVER_UUID] },
                { namePrefix: 'MYO_ROVER' }
            ],
            optionalServices: [
                DIS_SERVICE,
                BATTERY_SERVICE,
                MYO_ROVER_UUID,
                SERIAL_NUMBER_RESERVE_SERVICE
            ]
        });

        statusDiv.textContent = `Подключение к ${device.name || 'устройству'}...`;
        device.addEventListener('gattserverdisconnected', onDisconnected);
        server = await device.gatt.connect();
        statusDiv.textContent = `Подключено к ${device.name || 'устройству'}`;

        await readDIS();
        await readSerialFromReserve();
        await readBattery();
        await subscribeBatteryNotifications();
        await initInputCharacteristic();

        if (inputCharacteristic) {
            resetMotorUi();
            setControlsEnabled(true);
            startSendLoop();
        } else {
            setControlsEnabled(false);
            connectBtn.disabled = false;
            statusDiv.textContent = 'Управляющая характеристика не найдена';
        }
    } catch (error) {
        console.error(error);
        statusDiv.textContent = 'Ошибка: ' + error.message;
        stopSendLoop();
        setControlsEnabled(false);
        connectBtn.disabled = false;
        resetMotorUi();
    }
}

async function disconnectDevice() {
    stopMotors();
    await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
    stopSendLoop();
    try {
        if (device && device.gatt.connected) {
            device.gatt.disconnect();
        }
    } catch (error) {
        console.warn('Ошибка отключения:', error);
    }
}

function onDisconnected() {
    stopSendLoop();
    inputCharacteristic = null;
    server = null;
    setControlsEnabled(false);
    connectBtn.disabled = false;
    resetMotorUi();
    statusDiv.textContent = 'Статус: отключено';
}

async function readDIS() {
    try {
        const service = await server.getPrimaryService(DIS_SERVICE);
        for (const [key, uuid] of Object.entries(DIS_CHARS)) {
            try {
                const char = await service.getCharacteristic(uuid);
                const value = await char.readValue();
                const text = new TextDecoder('utf-8').decode(value).replace(/\0+$/, '').trim();
                document.getElementById(key).textContent = text || '—';
            } catch (e) {
                console.warn(`DIS ${key} не найдена или ошибка чтения`);
                document.getElementById(key).textContent = '—';
            }
        }
    } catch (e) {
        console.warn('Устройство не поддерживает DIS');
        for (const key of Object.keys(DIS_CHARS)) {
            document.getElementById(key).textContent = '—';
        }
    }
}

async function readSerialFromReserve() {
    try {
        const service = await server.getPrimaryService(SERIAL_NUMBER_RESERVE_SERVICE);
        const char = await service.getCharacteristic(SERIAL_NUMBER_RESERVE_CHARACTERISTIC);
        const value = await char.readValue();
        const text = new TextDecoder('utf-8').decode(value).replace(/\0+$/, '').trim();
        document.getElementById('serial').textContent = text || '—';
    } catch (e) {
        console.warn('Резервный сервис серийного номера недоступен');
        document.getElementById('serial').textContent = '—';
    }
}

async function readBattery() {
    try {
        const service = await server.getPrimaryService(BATTERY_SERVICE);
        const char = await service.getCharacteristic(BATTERY_CHAR);
        const value = await char.readValue();
        document.getElementById('battery-level').textContent = String(value.getUint8(0));
    } catch (e) {
        console.warn('Не удалось прочитать заряд батареи');
        document.getElementById('battery-level').textContent = '—';
    }
}

async function subscribeBatteryNotifications() {
    try {
        const service = await server.getPrimaryService(BATTERY_SERVICE);
        const char = await service.getCharacteristic(BATTERY_CHAR);
        if (char.properties.notify) {
            await char.startNotifications();
            char.addEventListener('characteristicvaluechanged', (event) => {
                document.getElementById('battery-level').textContent = String(event.target.value.getUint8(0));
            });
        }
    } catch (e) {
        console.log('Уведомления о батарее не поддерживаются');
    }
}

async function initInputCharacteristic() {
    try {
        const service = await server.getPrimaryService(MYO_ROVER_UUID);
        const inputChar = await service.getCharacteristic(MYO_ROVER_INPUT_UUID);
        if (inputChar.properties.write || inputChar.properties.writeWithoutResponse) {
            inputCharacteristic = inputChar;
        } else {
            inputCharacteristic = null;
        }
    } catch (e) {
        console.error('Не удалось найти сервис MYO Rover:', e);
        inputCharacteristic = null;
    }
}
