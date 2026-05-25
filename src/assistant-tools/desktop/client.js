import desktopAgentService from '../../desktop-agent/service.js';

export class AssistantDesktopClient {
  constructor({
    service = desktopAgentService
  } = {}) {
    this.service = service;
  }

  async health() {
    return this.service.health();
  }

  async listWindows(input = {}) {
    return this.service.windows(input);
  }

  async focusWindow(input = {}) {
    return this.service.focusWindow(input);
  }

  async launchApp(input = {}) {
    return this.service.launchApp(input);
  }

  async captureWindow(input = {}) {
    return this.service.captureWindow(input);
  }

  async findControl(input = {}) {
    return this.service.findControl(input);
  }

  async findAllControls(input = {}) {
    return this.service.findAllControls(input);
  }

  async actOnControl(input = {}) {
    return this.service.actOnControl(input);
  }

  async waitForControl(input = {}) {
    return this.service.waitForControl(input);
  }

  async pressKey(input = {}) {
    return this.service.pressKey(input);
  }

  async hotkey(input = {}) {
    return this.service.hotkey(input);
  }

  async typeText(input = {}) {
    return this.service.typeText(input);
  }

  async clickAt(input = {}) {
    return this.service.clickAt(input);
  }

  async moveMouse(input = {}) {
    return this.service.moveMouse(input);
  }

  async scroll(input = {}) {
    return this.service.scroll(input);
  }
}

const assistantDesktopClient = new AssistantDesktopClient();

export { assistantDesktopClient };
export default assistantDesktopClient;
