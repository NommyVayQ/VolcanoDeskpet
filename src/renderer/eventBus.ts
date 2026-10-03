type Callback = (...args: any[]) => void;

class EventBus {
  private events: Record<string, Callback[]> = {};

  on(event: string, callback: Callback) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
  }

  emit(event: string, ...args: any[]) {
    if (this.events[event]) this.events[event].forEach((cb) => cb(...args));
  }

  off(event: string, callback: Callback) {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter((cb) => cb !== callback);
    }
  }
}

export const eventBus = new EventBus();

// 事件名常量
export const EVENTS = {
  PET_INTERACT: 'pet:interact',
  USER_CLICK: 'user:click',
  PET_MENU_ACTION: 'pet:menu-action',
};
