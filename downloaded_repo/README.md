# DoV1_extract (with Interactive Web Workspace)

`DoV1_extract` is an optimized Dolby Vision RPU (Reference Processing Unit) metadata extractor for AV1 video streams, featuring both a production-ready C++ command-line terminal program and an interactive React web interface.

It parses AV1 bitstreams enclosed in IVF containers, unpacks ITU-T T.35 metadata OBUs (Open Bitstream Units) from Dolby Laboratories, performs bit-level EMDF (Extensible Metadata Format) header parsing, formats output to Standard HEVC UNSPEC62 NAL units (`00 00 00 01 7C 01`), and sorts them based on presentation timestamps (PTS).

---

## 🛠️ Key Design and Algorithm Fixes

Several critical algorithmic bugs were identified and successfully fixed in both the C++ and TypeScript parsing modules:

1. **Start Code Emulation Prevention Byte Insertion (`0x03` injection)**:
   * *Problem*: Original logic checked indices in the *input* buffer (`data[i-2] == 0 && data[i-1] == 0`) rather than checking the *output* written stream sequence (`result`). This caused false matches and corrupted Dolby Vision binary formatting.
   * *Solution*: Adjusted parsing checks to inspect the active output vector/array (`result`) state.
2. **Byte Boundary Offset Alignment**:
   * *Problem*: Parsing the EMDF header involves variable-length bitstream offsets, leaving the bit pointer non-aligned with byte boundaries. Instantly reading the raw payloads directly on these shifted boundaries caused shifted/corrupted buffer bytes templates.
   * *Solution*: Re-aligned the bit stream pointer to standard byte boundaries (`br.align()`) immediately prior to copying the payload.
3. **Conditional Extension Parsing Gate**:
   * *Problem*: The bitstream was unconditionally reading `payload_id_ext`, whereas according to Dolby EMDF specifications, `payload_id_ext` should *only* be parsed if `payload_id == 31`.
   * *Solution*: Gated reading behind an explicit conditional check `if (payload_id == 31)`.

---

## 🖥️ Web Interface Features

* **Drag-and-Drop Workspace**: Fast file ingestion with a beautiful, responsive drag-over workspace.
* **Live Extraction Stats**: Track frames parsed, total Dolby Vision RPUs successfully unpacked, processing speed (frames/sec), and output payload sizes.
* **Live Interactive Terminal Console**: Detailed info, success, warning, and error logs recorded frame-by-frame with smooth auto-scroll.
* **C++ Code Audit & Fixes Panel**: An embedded split-screen code comparison view displaying corrected portions of `DoV1_extract.cpp`.
* **Optimized Local Stream Parsing**: Evaluates chunks using micro-task sleep yields to prevent the browser interface from freezing.

---

## 🚀 Getting Started

### Running the Web Interface Locally
1. Install prerequisites and package dependencies in the workspace:
   ```bash
   npm install
   ```
2. Start the Vite development script:
   ```bash
   npm run dev
   ```
3. Open your browser and navigate to `http://localhost:3000` (or your active web app container link).

#### How to Use the Web Interface:
1. Drag and drop your `.ivf` or `.av1` stream file into the upload zone or click to browse.
2. Click the **Start Extraction** button to process.
3. Inspect telemetry metrics and logs inside the **Live Parsing Console**. 
4. Once completed, click **Download RPU (.bin)** to obtain the fully compliant Dolby Vision binary payload.

---

## 💻 Compiling and Running the C++ Command-Line Tool

Ensure a compiler with standard C++17 support (GCC, Clang, or MSVC) is installed.

### Build:
```bash
g++ -std=c++17 -O3 DoV1_extract.cpp -o DoV1_extract
```

### Usage:
```bash
./DoV1_extract -i {input_av1_file.ivf} -o {output_rpu.bin} [-v]
```

### Command Arguments:
* `-i`: Path to the input AV1 video file (requires an **IVF** container).
* `-o`: Path to the output binary file where the extracted Dolby Vision RPU payload will be saved.
* `-v`: (Optional) Verbose list formatting details frame-by-frame.
* `-h`: Shows the help message.
