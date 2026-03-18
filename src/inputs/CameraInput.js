/**
 * ImWeb Camera Input
 * WebRTC getUserMedia → Three.js VideoTexture
 */

import * as THREE from 'three';

export class CameraInput {
  constructor() {
    this.texture  = null;
    this.video    = null;
    this.active   = false;
    this.devices  = [];
    this._stream  = null;
  }

  async init() {
    await this._enumerateDevices();
  }

  async _enumerateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.devices = devices.filter(d => d.kind === 'videoinput');
    } catch (e) {
      console.warn('[Camera] Could not enumerate devices');
    }
  }

  async start(deviceId = null) {
    if (this._stream) this.stop();

    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    };

    try {
      this._stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video = document.createElement('video');
      this.video.srcObject = this._stream;
      this.video.playsInline = true;
      this.video.muted = true;
      await this.video.play();

      this.texture = new THREE.VideoTexture(this.video);
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.format    = THREE.RGBAFormat;
      this.active = true;

      console.info('[Camera] Started:', this._stream.getVideoTracks()[0].label);
      return true;
    } catch (err) {
      console.warn('[Camera] Failed to start:', err.message);
      this.active = false;
      return false;
    }
  }

  stop() {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.active = false;
  }

  tick() {
    if (this.texture && this.video?.readyState >= this.video.HAVE_CURRENT_DATA) {
      this.texture.needsUpdate = true;
    }
  }

  get currentTexture() {
    return this.active ? this.texture : null;
  }

  getDeviceList() { return this.devices; }
}
