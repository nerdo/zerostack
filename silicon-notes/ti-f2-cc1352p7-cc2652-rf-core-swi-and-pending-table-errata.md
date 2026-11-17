# Silicon Engineering Note: TI SimpleLink F2 (`CC2652P`, `CC2652P7` / `CC1352P7`, `CC2674P10`) RF Core SWI & Indirect Poll Turnaround Analysis

**Target Silicon:** Texas Instruments **CC2652P**, **CC2652R**, **CC2652RB**, **CC1352P2**, **CC1352P7** (`CC2652P7`), **CC2674P10** (SimpleLink Low Power F2 Platform)  
**Target Coordinator Hardware:** **SMLIGHT SLZB-06**, **SLZB-MR2** (`CC2652P`), **SLZB-06P7**, **SLZB-07P7**, **SLZB-MR1** (`CC2652P7` / `CC1352P7`), **SLZB-06P10**, **SLZB-07P10**, **SLZB-MR3**, **SLZB-MR4**, **SLZB-MRW10**, **SLZB-Ultima** (`CC2674P10`, incl. `U` variants)  
**Stack:** **[SMLIGHT ZeroStack — Release Zero](https://smlight.tech/software/zerostack)** (Zigbee 3.0 / PRO R23 Coordinator & Router)  
**Official ZeroStack Page:** [`https://smlight.tech/software/zerostack`](https://smlight.tech/software/zerostack)  
**Diagnostic MCP:** [`github.com/zerostack-rf/zerostack-mcp`](https://github.com/zerostack-rf/zerostack-mcp)

---

## 1. Architecture of the SimpleLink F2 Dual-Core Radio Interface

On Texas Instruments SimpleLink F2 devices (`CC2652P`, `CC2652P7` / `CC1352P7`, and `CC2674P10`), the IEEE 802.15.4 MAC is split across two asymmetric processor cores:
1. **Main Application MCU (ARM Cortex-M4F / Cortex-M33 @ 48 MHz)**: Runs the Zigbee PRO R23 stack, dynamic memory manager, security engine, and serial RPC transport.
2. **Autonomous RF Core (ARM Cortex-M0 Command & Packet Engine — CPE)**: Executes time-critical IEEE 802.15.4 operations (`192 µs` Auto-ACK turnaround, hardware pending-frame lookup, CSMA/CA backoff, and inline AES-128 security) using chained command structures in shared SRAM dispatched via the `RF_postCmd()` / `RF_scheduleCmd()` doorbell interface (`RFC_DBELL`).

Under high coordinator load (large populations of sleepy ZEDs polling concurrently with source-routed unicasts and group broadcasts), low-level race conditions between the main MCU TI-RTOS (`HwiP` / `SwiP`) layer and the Cortex-M0 RF Core cause stock Z-Stack firmware to stall or drop frames.

---

## 2. Radio Command Completion Software Interrupt Starvation & State Lockup

### Phenomenon
Under heavy bidirectional RF traffic or immediately following an Energy Detect (ED) scan / frequency synthesizer recalibration, the MAC TX state machine or radio command queue permanently stalls. Every subsequent outbound packet either times out or returns `0xe1: MAC_CHANNEL_ACCESS_FAILURE` (`225`) / `0x11: BUFFER_FULL` (`17`).

### Silicon & Driver Root Cause
In legacy radio driver integrations, when a foreground IEEE 802.15.4 command chain (`CMD_IEEE_CSMA` → `CMD_IEEE_TX` → `CMD_IEEE_RX_ACK`) finishes on the Cortex-M0 CPE, the hardware raises the `RFC_CPE_0` interrupt (`HwiP`):
1. The interrupt handler reads the CPE interrupt flags, clears command completion flags, and posts the completion event to the RF Software Interrupt (`SwiP`).
2. If a preemptive foreground abort or a synthesizer error callback races with the final microsecond of `CMD_IEEE_RX_ACK` completion while `SwiP` scheduling is temporarily disabled, the command completion transition can complete before the upper MAC callback receives its terminal event notification.
3. Because the upper MAC state machine waits deterministically for the terminal callback to re-arm the background `CMD_IEEE_RX` state, missing the completion transition leaves the MAC TX pipeline stuck indefinitely.

### ZeroStack Resolution
**[SMLIGHT ZeroStack](https://smlight.tech/software/zerostack)** enforces **self-healing receiver and synthesizer state recovery** (**Zero Freeze-Ups**), deterministically reconciling background `CMD_IEEE_RX` receive pipelines across every foreground CSMA/TX termination, Energy Detect scan, and synthesizer transition (`0` crashes across 3,255 MAC boundary/fuzz vectors).

---

## 3. Nested Critical Section Hazards (Interrupt Masking vs. RF Doorbell & NVRAM)

### Phenomenon
Intermittent hard lockups, missed UART RX bytes (causing `SRSP - AF - dataRequestExt after 6000ms`), or RF doorbell command rejections during simultaneous UART DMA interrupts and RF ACK reception.

### Silicon & Driver Root Cause
Legacy coordinator firmware holds critical sections across O(N) table walks and synchronous flash/radio doorbell operations:
- When the upper stack modifies the NWK indirect table, performs per-frame non-volatile security key lookups (`533,156` cycles = `11.11 ms` per NWK encrypt; `1,486,228` cycles = `30.96 ms` per TCLK miss on aged NV flash), or allocates from a linear first-fit heap (`2,550` cycles at 64 heap holes; `10,034` cycles = `209.0 µs` for timer start), interrupt latency spikes.
- Masking or delaying execution across millisecond-scale flash scans or NVRAM page compactions causes the main MCU to miss high-baudrate UART RX FIFO watermarks and delays `RFC_CPE_0` ISR servicing past the IEEE 802.15.4 symbol boundary.

### ZeroStack Resolution
ZeroStack eliminates O(N) linear heap scans and slow per-frame flash reads via:
- **Constant-Time O(1) Memory Allocator & Heap-Independent Timers**: **`218` CPU cycles (`4.5 µs`)** per allocation at 64 heap holes (**11.7× faster**) and **`1,448` cycles (`30.2 µs`)** per timer start (**6.9× faster**).
- **Constant-Time O(1) In-RAM Security Engine**: **`3,968` cycles (`82.7 µs`)** per NWK encrypt (**134.4× faster**, `0` flash reads), **`3,824` cycles (`79.7 µs`)** per NWK decrypt (**139.2× faster**), and **`326` cycles (`6.8 µs`)** per TCLK lookup miss (**4,559× faster**), keeping interrupt latency strictly bounded.

---

## 4. Sleepy End-Device Poll Turnaround & Indirect Queue Isolation

### Phenomenon
When large populations of sleepy Zigbee End Devices (Aqara, Sonoff, Tuya ZEDs) poll a `CC2652P`, `CC2652P7` (`CC1352P7`), or `CC2674P10` coordinator, children frequently experience poll timeouts (`0xe9: MAC_NO_ACK` / `0xf0: MAC_TRANSACTION_EXPIRED`) or indirect buffer exhaustion (`0xf1: MAC_TRANSACTION_OVERFLOW`), resulting in child detachment.

### Silicon & Driver Root Cause
Under IEEE 802.15.4 indirect transmission, when a sleepy End Device transmits a `MAC_DATA_REQ` poll, the coordinator must acknowledge with `Frame Pending (FP) = 1` and dequeue, encrypt, and transmit the held indirect packet before the sleepy child's `macMaxFrameTotalWaitTime` receive window closes.
1. If hardware pending-frame state updates race with background `CMD_IEEE_RX` transitions (such as channel calibration or foreground TX completion), pending-frame state can desynchronize from the software indirect queue.
2. On legacy Z-Stack, O(N⋅P) flash security scans (`11.11 ms` per NWK encrypt, `30.96 ms` per TCLK miss), synchronous NVRAM page compactions, and `3.00 s` broadcast echo stalls block the upper MAC so the indirect frame is transmitted after the ZED has already timed out and powered down its radio.
3. Furthermore, when multiple sleeping or offline ZEDs stop polling, unpaced indirect frames can exhaust the shared coordinator buffer pool (`0xf1: MAC_TRANSACTION_OVERFLOW` / `0x11: BUFFER_FULL`).

### ZeroStack Resolution
**[SMLIGHT ZeroStack](https://smlight.tech/software/zerostack)** eliminates sleepy-child poll dropouts (`0xe9: MAC_NO_ACK` / `0xf0: MAC_TRANSACTION_EXPIRED`) and indirect buffer exhaustion (`0xf1: MAC_TRANSACTION_OVERFLOW` / `0x11: BUFFER_FULL`) through two architectural invariants:
1. **Zero Flash-Read Stalls During Sleepy Poll Turnaround Windows**:
   - ZeroStack executes NWK encryption in **`82.7 µs` (`3,968` cycles, `0` flash reads — 134.4× faster)**, TCLK resolution in **`6.8 µs` (`326` cycles — 4,559× faster)**, and runs storage cleanup only when the radio is idle—ensuring queued indirect packets are dequeued and transmitted immediately while the polling ZED is still awake.
2. **Per-Child & Global Indirect Queue Quota Isolation (**Zero Battery-Device Bottlenecks**)**:
   - ZeroStack enforces bounded per-child and global indirect queue reservations backed by O(1) 218-cycle memory allocation, guaranteeing that unresponsive battery sensors never starve active mesh traffic.

---

## 5. Complete On-Silicon Subsystem Benchmark Reference (`CC1352P7` @ `48.0 MHz`)

All measurements below were captured directly from the ARM Cortex-M4F `DWT->CYCCNT` hardware cycle counter (`20.83 ns` resolution at `48.0 MHz`, `115,200` baud) on identical **TI SimpleLink `CC1352P7`** silicon across multi-dimensional load axes (S ∈ [0, 299] peer slots, D ∈ [0, 256] NVM flash log depth, k ∈ [0, 64] heap fragmentation holes, T ∈ [0, 39] active timers, and Q ∈ [0, 64] queued task messages).

### 5.1 Non-Volatile Memory (NVM) & Per-Packet Key Retrieval (`DWT->CYCCNT` Cycles)

| Operation / Workload | Legacy Reference Stack | SMLIGHT ZeroStack | Hardware Analysis |
| :--- | :--- | :--- | :--- |
| **Stack Key Read (D = 0, fresh log)** | `2,347` (`48.9 µs`) | **`302` (`6.3 µs`)** | **7.8× faster** even when the record sits at the very top of flash. |
| **Stack Key Read (D = 150 newer records)** | `64,817` (`1.35 ms`, `+416`/rec) | **`303` (`6.3 µs`)** | **213.9× faster.** Strictly O(1); legacy cost scales linearly with flash traffic. |
| **Write Unchanged Data (`2 B / 20 B / 100 B`)** | `19.1k / 35.3k / 100.7k` (`100,714` cyc) | **`2.0k / 2.3k / 3.8k` (`3,770` cyc)** | **Up to 26.7× faster.** ZeroStack writes **`0` bytes** to flash when data is unchanged (`48/48` writes; legacy appended on `48/48`). |
| **Write Changed Data (`2 B / 20 B / 100 B`)** | `19.1k / 35.4k / 102.2k` | `20.1k / 37.0k / 104.8k` | Physical flash programming time dominates when bytes genuinely mutate (`+3–5%` for integrity verification). |
| **General Item Read (Across D = 0..256)** | `581 – 14,303` (flash walk) | **`1,696 – 1,724` (flat)** | Flat across D = 0..256 regardless of log position. |
| **First Flash Page Compaction Threshold** | **Write #69** | **Write #1,013** | **14.7× more mutations** before compaction; zero wear on idempotent writes. |

### 5.2 Trust Center Link Key (TCLK) Resolution (300-Entry Table)

| Lookup Scenario | Legacy Reference Stack (Cycles / Time) | SMLIGHT ZeroStack (Cycles / Time) | Measured Speedup |
| :--- | :--- | :--- | :--- |
| **Hit, newest record (`Slot 0`)** | `2,961 – 2,963` (`61.7 µs`) | **`417` (`8.7 µs`)** | **7.1× faster** |
| **Hit, newest record (`Slot 299`)** | `2,962 – 2,963` (`61.7 µs`) | **`324` (`6.75 µs`)** | **9.1× faster** |
| **Hit, oldest record measured (age `383`)** | `620,396` (`12.92 ms`) | **`324` (`6.75 µs`)** | **1,915× faster** |
| **Miss, full 300-entry table (first contact)** | **`1,486,228` (`30.96 ms`)** | **`326` (`6.8 µs`)** | **4,559× faster** |

### 5.3 End-to-End Per-Frame NWK & APS Security (`DWT->CYCCNT` Cycles)

| Security Workload | Legacy Reference Stack | SMLIGHT ZeroStack | Operational Impact |
| :--- | :--- | :--- | :--- |
| **NWK Encrypt (D = 0)** | `8,558` (`178.3 µs`) | **`3,980` (`82.9 µs`)** | **2.15× faster** at zero flash depth. |
| **NWK Encrypt (D = 150)** | **`533,156` (`11.11 ms`)** | **`3,968` (`82.7 µs`)** | **134.4× faster.** Strictly flat (`0` flash reads/packet). |
| **NWK Decrypt (D = 0)** | `8,091` (`168.6 µs`) | **`3,840` (`80.0 µs`)** | **2.11× faster** at zero flash depth. |
| **NWK Decrypt (D = 150)** | **`532,182` (`11.09 ms`)** | **`3,824` (`79.7 µs`)** | **139.2× faster.** Legacy coordinator caps at `~45 routed pkt/s` vs **`>6,100 pkt/s`** (`162 µs` / hop). |
| **APS TX Encrypt (`Slot 0 -> 299`, D=0..100)** | `52,909` → **`409,301` (`8.53 ms`)** | **`5,410` → `5,424` (`0.113 ms`)** | **Up to 75.5× faster** and invariant to flash log order. |
| **Device Authentication Check (`Slot 0 -> 299`)** | `1,656` → `42,243` (`880 µs`) | **`181` → `179` (`3.7 µs`)** | **236× faster** at 300 nodes; flat by slot (legacy `~136` cycles/slot). |

### 5.4 Dynamic Heap Allocation (`malloc` / `free`), Timers, Queues & Host Serial

| Subsystem / State | Legacy Reference Stack | SMLIGHT ZeroStack | Speedup / Notes |
| :--- | :--- | :--- | :--- |
| **Heap `malloc` / `free` (k = 0 holes)** | `310` / `84` cyc | **`225`** / `200` cyc | **1.38× faster** baseline allocation. |
| **Heap `malloc` / `free` (k = 16 holes)** | `869` / `82` cyc | **`218`** / `175` cyc | **3.99× faster** `malloc`. |
| **Heap `malloc` / `free` (k = 32 holes)** | `1,430` / `82` cyc | **`220`** / `175` cyc | **6.50× faster** `malloc`. |
| **Heap `malloc` / `free` (k = 64 holes)** | **`2,550`** / `82` cyc | **`218`** / `175` cyc | **11.7× faster** `malloc` (`0` vs `~35` cycles/hole). |
| **Timer Start (T = 0 → 39, clean heap)** | `2,652` → `5,844` cyc | **`912` → `1,447` cyc** | **4.04× faster** at 39 active timers (legacy performs `2` heap allocs/start). |
| **Timer Start (T = 0 → 39, 64 heap holes)** | `6,894` → **`10,034` cyc (`209.0 µs`)** | **`930` → `1,448` cyc (`30.2 µs`)** | **6.93× faster.** Unaffected by heap fragmentation. |
| **Timer Stop (T = 0 → 39 active timers)** | `515` → `1,370` cyc | **`450` → `1,050` cyc** | **1.30× faster** at high timer load. |
| **Task `msgSend` (Q = 0 → 64 queued msgs)** | `497` → **`935` cyc** (`+7`/msg) | **`364` → `322` cyc (Flat)** | **2.90× faster** at Q=64; strictly O(1) enqueue. |
| **Task `msgReceive` (Q = 0 → 64 queued msgs)** | `383` → `628` cyc | **`168` → `333` cyc** | **2.28× faster** at Q=0, **1.89×** at Q=64. |
| **Host Serial `SYS_PING` (last RX byte to reply TX)** | Legacy baseline | **53% fewer total cycles** | **53% fewer total cycles; 83% faster reply path.** |
| **Host Serial `240 B` Frame (last RX byte to reply TX)** | `24,404` cyc | **`12,784` cyc** | **48% fewer cycles** on maximum-length ZNP frames. |
