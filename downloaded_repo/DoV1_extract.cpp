#include <iostream>
#include <fstream>
#include <vector>
#include <cstdint>
#include <string>
#include <algorithm>
#include <iomanip>

// BitReader for bit-level parsing
class BitReader {
    const uint8_t* data;
    size_t size;
    size_t bit_offset;

public:
    BitReader(const uint8_t* d, size_t s) : data(d), size(s), bit_offset(0) {}

    uint32_t read_bits(size_t n) {
        uint32_t value = 0;
        for (size_t i = 0; i < n; ++i) {
            if (bit_offset >= size * 8) return value;
            uint8_t byte = data[bit_offset / 8];
            uint8_t bit = (byte >> (7 - (bit_offset % 8))) & 1;
            value = (value << 1) | bit;
            bit_offset++;
        }
        return value;
    }

    bool read_bit() {
        return read_bits(1) != 0;
    }

    void align() {
        if (bit_offset % 8 != 0) {
            bit_offset += 8 - (bit_offset % 8);
        }
    }

    size_t available_bits() const {
        if (bit_offset >= size * 8) return 0;
        return size * 8 - bit_offset;
    }

    uint32_t read_variable_bits(size_t n) {
        uint32_t value = 0;
        uint32_t max_val = 1 << n;
        while (true) {
            uint32_t tmp = read_bits(n);
            value += tmp;
            if (!read_bit()) break;
            value <<= n;
            value += max_val;
        }
        return value;
    }
    
    // Read remaining bits into a byte vector, aligning correctly
    std::vector<uint8_t> read_remaining_bytes(size_t num_bytes) {
        std::vector<uint8_t> result;
        result.reserve(num_bytes);
        for (size_t i = 0; i < num_bytes; ++i) {
            result.push_back((uint8_t)read_bits(8));
        }
        return result;
    }
};

// LEB128 reader
uint64_t read_leb128(const std::vector<uint8_t>& data, size_t& offset) {
    uint64_t value = 0;
    uint64_t shift = 0;
    while (offset < data.size()) {
        uint8_t byte = data[offset++];
        value |= (static_cast<uint64_t>(byte & 0x7F) << shift);
        if ((byte & 0x80) == 0) break;
        shift += 7;
    }
    return value;
}

// Add HEVC start code emulation prevention (00 00 03)
std::vector<uint8_t> add_emulation_prevention(const std::vector<uint8_t>& data) {
    std::vector<uint8_t> result;
    result.reserve(data.size() * 3 / 2);
    for (size_t i = 0; i < data.size(); ++i) {
        size_t r_size = result.size();
        // BUGFIX: Check bytes in the output 'result' vector instead of input 'data' vector.
        // Checking input 'data' caused false matches and corrupted emulation prevention bytes insertion.
        if (r_size >= 2 && result[r_size-2] == 0 && result[r_size-1] == 0 && data[i] <= 3) {
            result.push_back(0x03);
        }
        result.push_back(data[i]);
    }
    return result;
}

struct RpuEntry {
    uint64_t timestamp;
    std::vector<uint8_t> rpu_data;
};

void print_help() {
    std::cout << "DoV1_extract - Dolby Vision RPU extractor for AV1 (IVF)\n";
    std::cout << "Usage: DoV1_extract -i {input_av1_ivf} -o {output_rpu_bin} [-v]\n";
    std::cout << "Options:\n";
    std::cout << "  -i    Input AV1 video file (IVF container)\n";
    std::cout << "  -o    Output RPU binary file (compatible with dovi_tool)\n";
    std::cout << "  -v    Verbose mode\n";
    std::cout << "  -h    Show this help\n";
}

int main(int argc, char* argv[]) {
    std::string input_path;
    std::string output_path;
    bool verbose = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "-i" && i + 1 < argc) input_path = argv[++i];
        else if (arg == "-o" && i + 1 < argc) output_path = argv[++i];
        else if (arg == "-v") verbose = true;
        else if (arg == "-h" || arg == "--help") {
            print_help();
            return 0;
        }
    }

    if (input_path.empty() || output_path.empty()) {
        print_help();
        return 1;
    }

    std::ifstream file(input_path, std::ios::binary);
    if (!file) {
        std::cerr << "Error: Could not open input file " << input_path << "\n";
        return 1;
    }

    // Read IVF Header
    uint8_t ivf_header[32];
    if (!file.read(reinterpret_cast<char*>(ivf_header), 32)) {
        std::cerr << "Error: Failed to read IVF header.\n";
        return 1;
    }

    if (std::string(reinterpret_cast<char*>(ivf_header), 4) != "DKIF") {
        std::cerr << "Error: Not a valid IVF file (DKIF signature missing).\n";
        return 1;
    }

    std::vector<RpuEntry> rpu_entries;
    uint32_t frame_count = 0;

    if (verbose) std::cout << "Analyzing frames...\n";

    while (true) {
        uint32_t frame_size;
        uint64_t timestamp;

        if (!file.read(reinterpret_cast<char*>(&frame_size), 4)) break;
        if (!file.read(reinterpret_cast<char*>(&timestamp), 8)) break;

        std::vector<uint8_t> frame_data(frame_size);
        if (!file.read(reinterpret_cast<char*>(frame_data.data()), frame_size)) break;

        size_t offset = 0;
        while (offset < frame_size) {
            uint8_t obu_header = frame_data[offset++];
            uint8_t obu_type = (obu_header >> 3) & 0x0F;
            bool obu_extension_flag = (obu_header >> 2) & 1;
            bool obu_has_size_field = (obu_header >> 1) & 1;

            if (obu_extension_flag) offset++;

            uint64_t obu_size = 0;
            if (obu_has_size_field) {
                obu_size = read_leb128(frame_data, offset);
            } else {
                obu_size = frame_size - offset;
            }

            if (obu_type == 5) { // OBU_METADATA
                size_t payload_start = offset;
                uint64_t metadata_type = read_leb128(frame_data, payload_start);

                if (metadata_type == 4) { // ITU-T T.35
                    uint8_t country_code = frame_data[payload_start++];
                    if (country_code == 0xB5) {
                        uint16_t provider_code = (frame_data[payload_start] << 8) | frame_data[payload_start + 1];
                        payload_start += 2;

                        if (provider_code == 0x003B) {
                            // Dolby Vision Signature: B5 00 3B 00 00 08 00 37 CD 08
                            // (Actually it starts after country_code)
                            uint32_t provider_oriented_code = (frame_data[payload_start] << 24) | (frame_data[payload_start+1] << 16) | 
                                                             (frame_data[payload_start+2] << 8) | frame_data[payload_start+3];
                            payload_start += 4;

                            if (provider_oriented_code == 0x00000800) {
                                // Bit-level parsing for EMDF
                                BitReader br(&frame_data[payload_start], (offset + obu_size) - payload_start);
                                
                                // Parse EMDF Header
                                uint32_t version = br.read_bits(2);     // 0
                                uint32_t key_id = br.read_bits(3);      // 6
                                uint32_t payload_id = br.read_bits(5);  // 31
                                uint32_t payload_id_ext = 0;
                                // BUGFIX: payload_id_ext only exists if payload_id is exactly 31.
                                // Reading variable bits unconditionally caused incorrect parsing offsets on profile streams.
                                if (payload_id == 31) {
                                    payload_id_ext = br.read_variable_bits(5) + 31; // 225
                                }
                                
                                br.read_bit(); // smploffste
                                br.read_bit(); // duratione
                                br.read_bit(); // groupide
                                br.read_bit(); // codecdatae
                                br.read_bit(); // discard_unknown_payload

                                uint32_t emdf_payload_size = br.read_variable_bits(8);
                                
                                if (verbose) {
                                    std::cout << "Frame " << std::setw(6) << frame_count 
                                              << ": Found DoVi RPU, size " << emdf_payload_size << " bytes\n";
                                }

                                // BUGFIX: The EMDF payload data starts on a byte boundary. Align the bit pointer 
                                // to the next byte boundary before reading raw payload bytes to avoid shifted buffer content.
                                br.align();
                                std::vector<uint8_t> rpu_raw = br.read_remaining_bytes(emdf_payload_size);
                                
                                // Prepend 0x19 prefix
                                std::vector<uint8_t> rpu_with_prefix;
                                rpu_with_prefix.push_back(0x19);
                                rpu_with_prefix.insert(rpu_with_prefix.end(), rpu_raw.begin(), rpu_raw.end());

                                rpu_entries.push_back({timestamp, rpu_with_prefix});
                            }
                        }
                    }
                }
            }
            offset += obu_size;
        }
        frame_count++;
    }

    if (rpu_entries.empty()) {
        std::cout << "No Dolby Vision metadata found in the input file.\n";
        return 0;
    }

    // Sort entries by timestamp to ensure presentation order
    std::sort(rpu_entries.begin(), rpu_entries.end(), [](const RpuEntry& a, const RpuEntry& b) {
        return a.timestamp < b.timestamp;
    });

    // Write to output file
    std::ofstream out_file(output_path, std::ios::binary);
    if (!out_file) {
        std::cerr << "Error: Could not open output file " << output_path << "\n";
        return 1;
    }

    for (const auto& entry : rpu_entries) {
        // Wrap in HEVC NAL: 00 00 00 01 7C 01 ...
        std::vector<uint8_t> rpu_with_ep = add_emulation_prevention(entry.rpu_data);
        
        uint8_t start_code[] = {0x00, 0x00, 0x00, 0x01};
        uint8_t nal_header[] = {0x7C, 0x01};
        
        out_file.write(reinterpret_cast<char*>(start_code), 4);
        out_file.write(reinterpret_cast<char*>(nal_header), 2);
        out_file.write(reinterpret_cast<char*>(rpu_with_ep.data()), rpu_with_ep.size());
    }

    std::cout << "Extraction complete.\n";
    std::cout << "Processed frames: " << frame_count << "\n";
    std::cout << "Extracted RPUs:  " << rpu_entries.size() << "\n";
    std::cout << "Saved to:        " << output_path << "\n";

    return 0;
}
