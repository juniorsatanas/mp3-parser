//     mp3-parser v0.1.4

//     https://github.com/biril/mp3-parser
//     Licensed and freely distributed under the MIT License
//     Copyright (c) 2013 Alex Lambiris

/*jshint browser:true */
/*global exports, define */
(function (root, createModule) {
    "use strict";

    // Expose as a module or global depending on the detected environment:

    // Global `define` method with `amd` property signifies an AMD loader (require.js, curl.js, ..)
    if (typeof define === "function" && define.amd) {
        return define(["exports"], function (exports) { return createModule(exports); });
    }

    // Global `exports` object signifies CommonJS enviroments with `module.exports`, e.g. Node
    if (typeof exports === "object") { return createModule(exports); }

    // If none of the above, then assume a browser, without AMD
    root.mp3Parser = createModule({});

    // Attach a `noConflict` method onto the `mp3Parser` global
    root.mp3Parser.noConflict = (function () {

        // Save a reference to the previous value of 'mp3Parser', so that it can be restored later
        //  on, if 'noConflict' is used
        var previousMp3Parser = root.mp3Parser;

        // Run in no-conflict mode, setting the `mp3Parser` global to to its previous value.
        //  Returns `mp3Parser`
        return function () {
            var mp3Parser = root.mp3Parser;
            root.mp3Parser = previousMp3Parser;
            mp3Parser.noConflict = function () { return mp3Parser; };
            return mp3Parser;
        };
    }());
}(this, function (mp3Parser) {
    "use strict";

    var
        // Produce octet's binary representation as a string
        octetToBinRep = (function () {
            var b = []; // The binary representation
            return function (octet) {
                b[0] = ((octet & 128) === 128 ? "1" : "0");
                b[1] = ((octet & 64)  === 64  ? "1" : "0");
                b[2] = ((octet & 32)  === 32  ? "1" : "0");
                b[3] = ((octet & 16)  === 16  ? "1" : "0");
                b[4] = ((octet & 8)   === 8   ? "1" : "0");
                b[5] = ((octet & 4)   === 4   ? "1" : "0");
                b[6] = ((octet & 2)   === 2   ? "1" : "0");
                b[7] = ((octet & 1)   === 1   ? "1" : "0");
                return b.join("");
            };
        }()),

        // Decode a [synchsafe](http://en.wikipedia.org/wiki/Synchsafe) value. Synchsafes are used
        //  in ID3 tags, instead of regular ints, to avoid the unintended introduction of bogus
        //  frame-syncs
        unsynchsafe = function (value) {
            var out = 0,
                mask = 0x7F000000;

            while (mask) {
                out >>= 1;
                out |= value & mask;
                mask >>= 8;
            }

            return out;
        },

        // Get a value indicating whether given DataView `buffer` contains the `sequence` string
        //  at `offset`. Will return the `sequence` itself if it does, false otherwise. Note that
        //  no check is performed for the adequate length of given buffer as this will be
        //  carried out be the caller as part of the section-parsing process
        isReadableSequence = function (sequence, buffer, offset) {
            for (var i = sequence.length - 1; i >= 0; i--) {
                if (sequence.charCodeAt(i) !== buffer.getUint8(offset + i)) { return false; }
            }
            return sequence;
        },

        // Parse DataView `buffer` begining at given `offset` and return a string built from
        //  `length` octets. Will essentially return the string comprised of octets
        //  [offset, offset + length)
        getReadableSequence = function(buffer, offset, length) {
            var sequence = [],
                i = offset,
                l = offset + length;
            for (; i < l; ++i) {
                sequence.push(String.fromCharCode(buffer.getUint8(i)));
            }
            return sequence.join("");
        },

        // Get the number of bytes in a frame given its `bitrate`, `samplingRate` and `padding`.
        //  Based on [a magic formula](http://mpgedit.org/mpgedit/mpeg_format/mpeghdr.htm)
        getFrameByteLength = function (bitrate, samplingRate, padding) {
            return Math.floor((144000 * bitrate / samplingRate) + padding);
        },

        //
        v1l3Bitrates = {
            "0000": "free",
            "0001": 32,
            "0010": 40,
            "0011": 48,
            "0100": 56,
            "0101": 64,
            "0110": 80,
            "0111": 96,
            "1000": 112,
            "1001": 128,
            "1010": 160,
            "1011": 192,
            "1100": 224,
            "1101": 256,
            "1110": 320,
            "1111": "bad"
        },

        //
        v1l3SamplingRates = {
            "00": 44100,
            "01": 48000,
            "10": 32000,
            "11": "reserved"
        },

        //
        v1l3ChannelModes = {
            "00": "Stereo",
            "01": "Joint stereo (Stereo)",
            "10": "Dual channel (Stereo)",
            "11": "Single channel (Mono)"
        };

    // ### Notes
    //
    // The parser exposes a collection of `read____` methods, each dedicated to reading a specific
    //  section of the mp3 file. The current implementation includes `readFrameHeader`, `readFrame`,
    //  `readId3v2Tag` and `readXingTag`. Each of these accepts a DataView-wrapped ArrayBuffer,
    //  which should contain the actual mp3 data, and optionally an offset into the buffer.
    //
    // All methods return a description of the section read in the form of a hash containing
    //  key-value pairs relevant to the section. For example the hash returned from
    //  `readFrameHeader` always contains an `mpegAudioVersion` key of value "MPEG Version 1
    //  (ISO/IEC 11172-3)" and a `layerDescription` key of value "Layer III". A description will
    //  always have a `_section` hash with `type`, `byteLength` and `offset` keys:
    //
    //  * `type`: "frame", "frameHeader", "Xing" or "ID3"
    //  * `byteLenfth`: Size of the section in bytes
    //  * `offset`: Buffer offset at which this section resides
    mp3Parser;


    // ### Read a Frame Header
    //
    // Read header of frame located at `offset` of DataView `buffer`. Returns null in the event
    //  that no frame header is found at `offset`
    mp3Parser.readFrameHeader = function (buffer, offset) {
        offset || (offset = 0);

        var
            // The header's four bytes
            b1, b2, b3, b4,

            //
            header = {
                _section: {
                    type: "frameHeader",
                    byteLength: 4,
                    offset: offset
                }
            };

        // There should be more than 4bytes ahead
        if (buffer.byteLength - offset <= 4) { return null; }

        b1 = buffer.getUint8(offset);
        b2 = buffer.getUint8(offset + 1);
        b3 = buffer.getUint8(offset + 2);
        b4 = buffer.getUint8(offset + 3);

        // First octet: `11111111`: Frame sync (all bits must be set)
        if (b1 !== 255) { return null; }

        // Second octet: `11111011` or `11111010`
        //
        // * `111.....`: Rest of frame sync (all bits must be set)
        // * `...11...`: MPEG Audio version ID (11 -> MPEG Version 1 (ISO/IEC 11172-3))
        // * `.....01.`: Layer description (01 -> Layer III)
        // * `.......1`: Protection bit (1 = Not protected)

        // Require the seven most significant bits to be `1111101` (>= 250)
        if (b2 < 250) { return null; }

        header.mpegAudioVersionBits = "11";
        header.mpegAudioVersion = "MPEG Version 1 (ISO/IEC 11172-3)";
        header.layerDescriptionBits = "01";
        header.layerDescription = "Layer III";
        header.isProtected = b2 & 1; // Just check if last bit is set
        header.protectionBit = header.isProtected ? "1" : "0";


        // Third octet: `EEEEFFGH`
        //
        // * `EEEE....`: Bitrate index. 1111 is invalid, everything else is accepted
        // * `....FF..`: Sampling rate, 00=44100, 01=48000, 10=32000, 11=reserved
        // * `......G.`: Padding bit, 0=frame not padded, 1=frame padded
        // * `.......H`: Private bit. This is informative
        b3 = octetToBinRep(b3);
        header.bitrateBits = b3.substr(0, 4);
        header.bitrate = v1l3Bitrates[header.bitrateBits];
        if (header.bitrate === "bad") { return null; }

        header.samplingRateBits = b3.substr(4, 2);
        header.samplingRate = v1l3SamplingRates[header.samplingRateBits];
        if (header.samplingRate === "reserved") { return null; }

        header.frameIsPaddedBit = b3.substr(6, 1);
        header.frameIsPadded = header.frameIsPaddedBit === "1";
        header.framePadding = header.frameIsPadded ? 1 : 0;

        header.privateBit = b3.substr(7, 1);

        // Fourth octet: `IIJJKLMM`
        //
        // * `II......`: Channel mode
        // * `..JJ....`: Mode extension (only if joint stereo)
        // * `....K...`: Copyright
        // * `.....L..`: Original
        // * `......MM`: Emphasis
        b4 = octetToBinRep(b4);
        header.channelModeBits = b4.substr(0, 2);
        header.channelMode = v1l3ChannelModes[header.channelModeBits];

        return header;
    };


    // ### Read a Frame
    //
    // Read frame located at `offset` of DataView `buffer`. Will acquire the frame header (see
    //  `readFrameHeader`) plus some basic information about the frame - notably the length if the
    //  frame in bytes. If `requireNextFrame` is set, the presence of a next valid frame will be
    //  required for _this_ frame to be regarded as valid. Returns null in the event that no frame
    //  is found at `offset`
    mp3Parser.readFrame = function (buffer, offset, requireNextFrame) {
        offset || (offset = 0);

        var frame = {
                _section: {
                    type: "frame",
                    offset: offset
                },
                header: mp3Parser.readFrameHeader(buffer, offset)
            };

        // Frame should alwas begin with a valid header
        if (!frame.header) { return null; }

        // The num of samples per v1l3 frame is constant - always 1152
        frame._section.sampleLength = 1152;

        //
        frame._section.byteLength = getFrameByteLength(frame.header.bitrate, frame.header.samplingRate, frame.header.framePadding);
        frame._section.nextFrameIndex = offset + frame._section.byteLength;

        // No "Xing" or "Info" identifier should reside at octet 36 - this would indicate that this
        //  is in fact a Xing tag masquerading as a frame
        if (isReadableSequence("Xing", buffer, offset + 36) || isReadableSequence("Info", buffer, offset + 36)) {
            return null;
        }

        // If a next frame is required then the data at `frame._section.nextFrameIndex` should be
        //  a valid frame header
        if (requireNextFrame && !mp3Parser.readFrameHeader(buffer, frame._section.nextFrameIndex)) {
            return null;
        }

        return frame;
    };


    // ### Read the Last Frame
    //
    // Locate and read the very last valid frame in given DataView `buffer`. The search is carried
    //  out in reverse, from given `offset` (or the very last octet if `offset` is ommitted) to the
    //  first octet in the buffer. If `requireNextFrame` is set, the presence of a next valid frame
    //  will be required for any found frame to be regarded as valid (causing the method to
    //  essentially return the next-to-last frame on success). Returns null in the event that no
    //  frame is found at `offset`
    mp3Parser.readLastFrame = function (buffer, offset, requireNextFrame) {
        offset || (offset = buffer.byteLength - 1);

        var lastFrame = null;

        for (; offset >= 0; --offset) {
            if (buffer.getUint8(offset) === 255) {
                // Located a candidate frame as 255 is a possible frame-sync byte
                lastFrame = mp3Parser.readFrame(buffer, offset, requireNextFrame);
                if (lastFrame) { return lastFrame; }
            }
        }

        return null;
    };


    // ### Read the ID3v2 Tag
    //
    // Read [ID3v2 Tag](http://id3.org/id3v2.3.0) located at `offset` of DataView `buffer`. Returns
    //  null in the event that no frame is found at `offset`
    mp3Parser.readId3v2Tag = function (buffer, offset) {
        offset || (offset = 0);

        // The ID3v2 tag header, which should be the first information in the file, is 10 bytes:
        //
        // * identifier: 3 octets: always "ID3" (0x49/73, 0x44/68, 0x33/51)
        // * version:    2 octets: major version + revision number
        // * flags:      1 octet : abc00000. a:unsynchronisation, b:extended header, c:experimental
        // * size:       4 octets: tag size as a synchsafe integer

        // There should be at least 10 bytes ahead
        if (buffer.byteLength - offset < 10) { return null; }

        // Check for the presense of ID3 identifier
        if (!isReadableSequence("ID3", buffer, offset)) { return null; }

        var
            //
            flagsOctet = buffer.getUint8(offset + 5),

            //
            tag = {
                _section: {
                    type: "ID3v2",
                    offset: offset
                },
                header: {
                    majorVersion: buffer.getUint8(offset + 3),
                    minorRevision: buffer.getUint8(offset + 4),
                    flagsOctet: flagsOctet,
                    unsynchronisationFlag: (flagsOctet & 128) === 128,
                    extendedHeaderFlag: (flagsOctet & 64) === 64,
                    experimentalIndicatorFlag: (flagsOctet & 32) === 32,
                    size: unsynchsafe(buffer.getUint32(offset + 6))
                },
                frames: []
            },

            // Index of octet following tag's last octet: The tag spans [offset, tagEnd) (including
            //  the first 10 header octets)
            tagEnd,

            // To store frames as they're discovered while paring the tag
            frame;

        // The size as expressed in the header is the size of the complete tag after
        //  unsychronisation, including padding, excluding the header but not excluding the
        //  extended header (total tag size - 10)
        tag._section.byteLength = tag.header.size + 10;
        tagEnd = offset + tag._section.byteLength;

        // TODO: Process extended header if present
        if (tag.header.extendedHeaderFlag) {}

        // All frames consist of a frame header followed by one or more fields containing the
        //  actual information. The layout of the frame header:
        //
        // * Frame ID: xx xx xx xx (four characters)
        // * Size:     xx xx xx xx (frame size excluding frame header (frame size - 10))
        // * Flags:    xx xx

        // Move offset past the end of the tag header to start reading tag frames
        offset += 10;
        while (offset < tagEnd) {

            // Locating a frame with a zeroed out id indicates that all actual frames have already
            //  been parsed. It's all dead space hereon so practically, we're done
            if (buffer.getUint32(offset) === 0) { break; }

            // Parse the frame
            frame = {
                header: {
                    id: getReadableSequence(buffer, offset, 4),
                    size: buffer.getUint32(offset + 4),
                    flagsOctet1: buffer.getUint8(offset + 8),
                    flagsOctet2: buffer.getUint8(offset + 9)
                }
            };
            frame.content = getReadableSequence(buffer, offset + 10, frame.header.size);

            tag.frames.push(frame);
            offset += frame.header.size + 10;
        }

        return tag;
    };


    // ### Read the Xing Tag
    //
    // Read [Xing / Lame Tag](http://gabriel.mp3-tech.org/mp3infotag.html) located at `offset` of
    //  DataView `buffer`. Returns null in the event that no frame is found at `offset`
    mp3Parser.readXingTag = function (buffer, offset) {
        offset || (offset = 0);

        var tag = {
                _section: {
                    type: "Xing",
                    offset: offset
                },
                header: mp3Parser.readFrameHeader(buffer, offset)
            };

        // The Xing header should begin with a valid frame header
        if (!tag.header) { return null; }

        // There should be at least 36 + 4 = 40 bytes ahead
        if (buffer.byteLength < offset + 40) { return null; }

        // A "Xing" or "Info" identifier should reside at octet 36
        (tag.identifier = isReadableSequence("Xing", buffer, offset + 36)) ||
        (tag.identifier = isReadableSequence("Info", buffer, offset + 36));
        if (!tag.identifier) { return null; }

        //
        tag._section.byteLength = getFrameByteLength(tag.header.bitrate, tag.header.samplingRate, tag.header.framePadding);
        tag._section.nextFrameIndex = offset + tag._section.byteLength;

        return tag;
    };


    // ### Read all Tags up to First Frame
    //
    // http://www.rengels.de/computer/mp3tags.html
    // http://stackoverflow.com/q/5005476/612262
    mp3Parser.readTags = function (buffer, offset) {
        offset || (offset = 0);

        var sections = [],
            section = null,
            readers = [mp3Parser.readId3v2Tag, mp3Parser.readXingTag, mp3Parser.readFrame],
            foundFirstFrame = false,
            i = 0,
            numOfReaders = readers.length,
            bufferLength = buffer.byteLength;

        // While we haven't located the first frame, pick the next offset ..
        for (; offset < bufferLength && !foundFirstFrame; ++offset) {

            // .. And try out each of the 'readers' on it
            for (i = 0; i < numOfReaders; ++i) {
                section = readers[i](buffer, offset);

                // If one of the readers successfully parses a section ..
                if (section) {

                    // .. store it ..
                    sections.push(section);

                    // .. and push the offset to the very end of end of that section. This way,
                    //  we avoid iterating over offsets which definately aren't the begining of
                    //  some section (they're part of the located section)
                    offset += section._section.byteLength;

                    // If the section we just parsed is a frame then we've actually located the
                    //  first frame. Break out of the readers-loop making sure to set
                    //  foundFirstFrame (so that we also exit the outer loop)
                    if (section._section.type === "frame") {
                        foundFirstFrame = true;
                        break;
                    }

                    // The section is _not_ the first frame. So, having pushed the offset
                    //  appropriately, retry all readers
                    i = -1;
                }
            }
        }

        return sections;
    };

    // Attach the `version` property to mp3 Parser and return it
    Object.defineProperties(mp3Parser, {

        // Get current version of mp3-parser
        version: { get: function () { return "0.1.4"; } }
    });

    return mp3Parser;
}));