import type { LocalStore } from "@varveai/adit-core";
import { OnDemandWorker } from "./on-demand-worker.js";
import { createMaintenanceSchema, maintenanceTasks, type MaintenanceProgress, type MaintenanceTask } from "./maintenance-tasks.js";

export class MaintenanceService {
  private worker: OnDemandWorker;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  get busy() { return this.running; }
  private updatePaused = false;
  pauseForUpdate(paused: boolean) {
    this.updatePaused = paused;
    if (paused) { clearTimeout(this.timer); this.timer = undefined; }
    else this.start();
  }
  private failures = 0;

  constructor(private store: LocalStore, workerUrl = new URL("./maintenance-worker.js", import.meta.url)) {
    createMaintenanceSchema(store.db);
    this.worker = new OnDemandWorker(workerUrl, { path: store.dbPath }, () => new Error("Local maintenance failed"), { idleTimeout: 1000 });
  }

  status(): MaintenanceProgress[] {
    return this.store.db.prepare("SELECT * FROM adit_local_maintenance ORDER BY task").all() as MaintenanceProgress[];
  }

  start(delay = 5000) {
    if (this.stopped || this.running || this.timer || this.updatePaused) return;
    if (maintenanceTasks.every(task => this.status().some(progress => progress.task === task && progress.status === "done"))) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
    this.timer.unref();
  }

  private async run() {
    if (this.stopped) return;
    this.running = true;
    let delay = 50;
    let task: MaintenanceTask | undefined;
    try {
      const progress = this.status();
      task = maintenanceTasks.find(candidate => !progress.some(row => row.task === candidate && row.status === "done"));
      if (!task) return;
      const result = await this.worker.request<{ paused?: boolean; progress?: MaintenanceProgress }>({ task });
      this.failures = 0;
      if (result.paused) delay = 10_000;
    } catch {
      if (!this.stopped && task) {
        this.failures++;
        try {
          this.store.db.prepare(`INSERT INTO adit_local_maintenance VALUES (?,'failed',0,-1,0,0,0,0,?,'Local maintenance failed')
            ON CONFLICT(task) DO UPDATE SET status='failed',updated_at=excluded.updated_at,error=excluded.error`).run(task, Date.now());
        } catch {}
      }
      delay = 30_000;
    } finally {
      this.running = false;
      if (this.failures < 3) this.start(delay);
    }
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.worker.close();
  }
}
