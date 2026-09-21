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
const STICK_THUMB_SIZE = 56;

let device = null;
let server = null;
let inputCharacteristic = null;
let sendTimer = null;
let writeInFlight = false;
let pendingPayload = null;
let txCount = 0;

let m1 = 0;
let m2 = 0;

const connectBtn = document.getElementById('connectBtn');
const stopBtn = document.getElementById('stopBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusDiv = document.getElementById('status');
const txStatus = document.getElementById('txStatus');
const m1Stick = document.getElementById('m1Stick');
const m2Stick = document.getElementById('m2Stick');
const m1Thumb = document.getElementById('m1Thumb');
const m2Thumb = document.getElementById('m2Thumb');
const m1Value = document.getElementById('m1Value');
const m2Value = document.getElementById('m2Value');

connectBtn.addEventListener('click', connectDevice);
stopBtn.addEventListener('click', stopMotors);
disconnectBtn.addEventListener('click', disconnectDevice);

bindStick(m1Stick, 'm1');
bindStick(m2Stick, 'm2');
updateStickUi();

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopMotors();
    }
});

window.addEventListener('pagehide', () => {
    stopMotors();
});

function clampMotor(value) {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) {
        return 0;
    }
    return Math.max(-100, Math.min(100, n));
}

function motorPayload(left, right) {
    return new Uint8Array([clampMotor(left) & 0xFF, clampMotor(right) & 0xFF]);
}

function bindStick(el, motor) {
    const onPointer = (event) => {
        if (el.classList.contains('disabled')) {
            return;
        }
        event.preventDefault();
        setMotorFromPointer(el, motor, event.clientY);
    };

    const release = (event) => {
        if (event && el.hasPointerCapture(event.pointerId)) {
            el.releasePointerCapture(event.pointerId);
        }
        resetMotor(motor);
    };

    el.addEventListener('pointerdown', (event) => {
        if (el.classList.contains('disabled')) {
            return;
        }
        el.setPointerCapture(event.pointerId);
        onPointer(event);
    });
    el.addEventListener('pointermove', (event) => {
        if (!el.hasPointerCapture(event.pointerId)) {
            return;
        }
        onPointer(event);
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', () => resetMotor(motor));
}

function resetMotor(motor) {
    if (motor === 'm1') {
        m1 = 0;
    } else {
        m2 = 0;
    }
    updateStickUi();
    sendMotorCommand(m1, m2);
}

function setMotorFromPointer(el, motor, clientY) {
    const rect = el.getBoundingClientRect();
    const ratio = (clientY - rect.top) / rect.height;
    const value = clampMotor(Math.round((0.5 - ratio) * 200));
    if (motor === 'm1') {
        m1 = value;
    } else {
        m2 = value;
    }
    updateStickUi();
    sendMotorCommand(m1, m2);
}

function updateStickUi() {
    m1Value.textContent = String(m1);
    m2Value.textContent = String(m2);
    positionThumb(m1Stick, m1Thumb, m1);
    positionThumb(m2Stick, m2Thumb, m2);
}

function positionThumb(stick, thumb, value) {
    const travel = stick.clientHeight - STICK_THUMB_SIZE;
    const top = ((100 - value) / 200) * travel;
    thumb.style.top = `${top}px`;
    thumb.style.transform = 'none';
}

function setControlsEnabled(enabled) {
    m1Stick.classList.toggle('disabled', !enabled);
    m2Stick.classList.toggle('disabled', !enabled);
    stopBtn.disabled = !enabled;
    disconnectBtn.disabled = !enabled;
    connectBtn.disabled = enabled;
}

function resetMotorUi() {
    m1 = 0;
    m2 = 0;
    updateStickUi();
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
    const payload = motorPayload(left, right);
    if (!inputCharacteristic) {
        txStatus.textContent = 'Отправка: нет характеристики управления';
        return;
    }
    if (writeInFlight) {
        pendingPayload = payload;
        return;
    }

    writeInFlight = true;
    try {
        if (inputCharacteristic.properties.write) {
            if (typeof inputCharacteristic.writeValueWithResponse === 'function') {
                await inputCharacteristic.writeValueWithResponse(payload);
            } else {
                await inputCharacteristic.writeValue(payload);
            }
        } else if (inputCharacteristic.properties.writeWithoutResponse) {
            await inputCharacteristic.writeValueWithoutResponse(payload);
        } else {
            throw new Error('Характеристика не поддерживает запись');
        }
        txCount += 1;
        const signedM1 = clampMotor(left);
        const signedM2 = clampMotor(right);
        txStatus.textContent = `Отправка #${txCount}: M1=${signedM1} M2=${signedM2} [${payload[0]}, ${payload[1]}]`;
    } catch (error) {
        console.error('Ошибка записи команды моторов:', error);
        statusDiv.textContent = 'Ошибка отправки: ' + error.message;
        txStatus.textContent = 'Отправка не удалась: ' + error.message;
    } finally {
        writeInFlight = false;
        if (pendingPayload) {
            const next = pendingPayload;
            pendingPayload = null;
            const nextM1 = next[0] > 127 ? next[0] - 256 : next[0];
            const nextM2 = next[1] > 127 ? next[1] - 256 : next[1];
            sendMotorCommand(nextM1, nextM2);
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
            txCount = 0;
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
    txStatus.textContent = 'Отправка: нет соединения';
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
