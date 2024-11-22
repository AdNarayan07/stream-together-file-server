import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import WebTorrent from "webtorrent";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

// Set FFmpeg binary path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = 3000;
const VIDEO_DIR = path.join(process.cwd(), "videos");
const progressClients = {};

// Ensure the videos directory exists
if (!fs.existsSync(VIDEO_DIR)) {
  fs.mkdirSync(VIDEO_DIR);
}

// Serve video files
app.get("/videos/:filename", (req, res) => {
  try {
    const { filename } = req.params;
    const videoPath = path.join(VIDEO_DIR, filename);

    fs.stat(videoPath, (err, stats) => {
      if (err || !stats.isFile()) {
        return res.status(404).send("File not found");
      }

      const range = req.headers.range;
      const videoSize = stats.size;

      if (!range) {
        const headers = {
          "Content-Type": "video/mp4",
          "Content-Length": videoSize,
        };
        res.writeHead(200, headers);
        fs.createReadStream(videoPath).pipe(res);
      } else {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : videoSize - 1;

        const chunkSize = end - start + 1;
        const headers = {
          "Content-Range": `bytes ${start}-${end}/${videoSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": "video/mp4",
        };

        res.writeHead(206, headers);
        fs.createReadStream(videoPath, { start, end }).pipe(res);
      }
    });
  } catch (err) {
    console.error("Error in video streaming:", err);
    res.status(500).send("Internal server error");
  }
});

// Get video information
app.get("/videos/info/:filename", (req, res) => {
  const { filename } = req.params;
  const videoPath = path.join(VIDEO_DIR, filename);

  fs.stat(videoPath, (err, stats) => {
    if (err || !stats.isFile()) {
      return res.status(404).send("File not found");
    }

    ffmpeg.ffprobe(videoPath, (error, metadata) => {
      if (error) {
        console.error("Error retrieving video info:", error);
        return res.status(500).send("Failed to retrieve video information");
      }

      res.status(200).json({
        filename,
        size: stats.size,
        format: metadata.format.format_name,
        duration: metadata.format.duration,
        bit_rate: metadata.format.bit_rate,
        video_codec: metadata.streams.find((s) => s.codec_type === "video")?.codec_name,
        resolution: `${metadata.streams.find((s) => s.codec_type === "video")?.width}x${metadata.streams.find((s) => s.codec_type === "video")?.height}`,
        audio_codec: metadata.streams.find((s) => s.codec_type === "audio")?.codec_name,
        audio_channels: metadata.streams.find((s) => s.codec_type === "audio")?.channels,
        subtitle_tracks: metadata.streams.filter((s) => s.codec_type === "subtitle").length,
        subtitles: metadata.streams
          .filter((s) => s.codec_type === "subtitle")
          .map((sub, index) => ({
            track: index + 1,
            language: sub.tags?.language || "Unknown",
            codec: sub.codec_name,
          })),
      });
    });
  });
});

// SSE endpoint for progress updates
app.get("/progress/:id", (req, res) => {
  const { id } = req.params;

  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Store the response object to send updates later
  progressClients[id] = res;

  // Immediately send a connection acknowledgment
  res.write(`data: ${JSON.stringify({ status: "connected", percent: 0 })}\n\n`);

  // Remove client when connection is closed
  req.on("close", () => {
    delete progressClients[id];
  });
});

// Download a video from a direct URL
app.post("/download/url", express.json(), async (req, res) => {
  const { url, filename, taskId } = req.body;

  if (!url || !filename || !taskId) {
    return res.status(400).send("URL, filename, and taskId are required");
  }

  const videoPath = path.join(VIDEO_DIR, filename);

  try {
    const response = await axios({
      method: "get",
      url,
      responseType: "stream",
    });

    const writer = fs.createWriteStream(videoPath);

    // Track download progress
    response.data.on("data", (chunk) => {
      if (progressClients[taskId]) {
        const progress = Math.round((writer.bytesWritten / response.headers["content-length"]) * 10000) / 100;
        progressClients[taskId].write(`data: ${JSON.stringify({ percent: progress, status: "downloading" })}\n\n`);
      }
    });

    response.data.pipe(writer);

    writer.on("finish", () => {
      if (progressClients[taskId]) {
        progressClients[taskId].write(`data: ${JSON.stringify({ percent: 100, status: "completed" })}\n\n`);
        progressClients[taskId].end();
      }
      res.status(200).send("Video downloaded successfully");
    });

    writer.on("error", (err) => {
      if (progressClients[taskId]) {
        progressClients[taskId].write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
        progressClients[taskId].end();
      }
      res.status(500).send("Error downloading video");
    });
  } catch (err) {
    if (progressClients[taskId]) {
      progressClients[taskId].write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
      progressClients[taskId].end();
    }
    console.error("Error downloading video:", err);
    res.status(500).send("Failed to download video from URL");
  }
});

// Download a video using a torrent magnet link
app.post("/download/torrent", express.json(), (req, res) => {
  const { magnetLink, taskId } = req.body;

  if (!magnetLink || !taskId) {
    return res.status(400).send("Magnet link and taskId are required");
  }

  const client = new WebTorrent();
  client.on("error", (err) => {
    console.error("Error downloading torrent:", err);
      res.status(500).send("Error downloading torrent: \n" + err);
  })

  client.add(magnetLink, { path: VIDEO_DIR }, (torrent) => {
    let totalBytes = 0
    let oldpercent = 0
    torrent.on("download", (bytes) => {
      if (progressClients[taskId]) {
        totalBytes += bytes
        const percent = Math.round((totalBytes / torrent.length) * 10000) / 100;
        if(percent > oldpercent) {
          progressClients[taskId].write(`data: ${JSON.stringify({ percent, status: "downloading" })}\n\n`);
          oldpercent = percent
        }
      }
    });

    torrent.on("done", () => {
      if (progressClients[taskId]) {
        progressClients[taskId].write(`data: ${JSON.stringify({ percent: 100, status: "completed" })}\n\n`);
        progressClients[taskId].end();
      }
      res.status(200).send(`Downloaded: ${torrent.name}`);
      client.destroy();
    });

    torrent.on("error", (err) => {
      if (progressClients[taskId]) {
        progressClients[taskId].write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
        progressClients[taskId].end();
      }
      console.error("Error downloading torrent:", err);
      res.status(500).send("Error downloading torrent");
      client.destroy();
    });
  });
});

app.post("/process/convert", express.json(), (req, res) => {
  const {
    inputFilename,
    outputFilename,
    codec,
    crf,
    preset,
    bitrate,
    resolution,
    taskId,
  } = req.body;

  if (!inputFilename || !outputFilename || !taskId) {
    return res.status(400).send("Input filename, output filename, and taskId are required");
  }

  const inputPath = path.join(VIDEO_DIR, inputFilename);
  const outputPath = path.join(VIDEO_DIR, outputFilename);

  const ffmpegCommand = ffmpeg(inputPath);

  // Apply codec (default is libx264)
  if (codec) {
    ffmpegCommand.videoCodec(codec);
  }

  // Add CRF for quality control (works with libx264 or libx265)
  if (crf !== undefined) {
    ffmpegCommand.outputOptions(`-crf ${crf}`);
  }

  // Add preset for compression speed (works with libx264 or libx265)
  if (preset) {
    ffmpegCommand.outputOptions(`-preset ${preset}`);
  }

  // Add bitrate control (fixed bitrate)
  if (bitrate) {
    ffmpegCommand.outputOptions(`-b:v ${bitrate}`);
  }

  // Add resolution scaling
  if (resolution) {
    ffmpegCommand.size(resolution);
  }

  // Progress and Completion Handlers
  ffmpegCommand
    .on("progress", (progress) => {
      if (progressClients[taskId]) {
        const percent = Math.round(progress.percent * 100 || 0) / 100;
        progressClients[taskId].write(
          `data: ${JSON.stringify({ percent, status: "processing" })}\n\n`
        );
      }
    })
    .on("end", () => {
      if (progressClients[taskId]) {
        progressClients[taskId].write(`data: ${JSON.stringify({ percent: 100, status: "completed" })}\n\n`);
        progressClients[taskId].end();
      }
      res.status(200).send(`File processed successfully: ${outputFilename}`);
    })
    .on("error", (err) => {
      if (progressClients[taskId]) {
        progressClients[taskId].write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
        progressClients[taskId].end();
      }
      console.error("Error processing video:", err);
      res.status(500).send("Error processing video");
    })
    .save(outputPath);
});

app.post("/process/extract-subtitles", express.json(), (req, res) => {
  const { inputFilename } = req.body;

  if (!inputFilename) {
    return res.status(400).send("Input filename is required");
  }

  const inputPath = path.join(VIDEO_DIR, inputFilename);

  ffmpeg(inputPath)
    .outputOptions("-map 0:s:0?") // Extract the first subtitle track
    .format("webvtt") // Specify WebVTT format (vtt)
    .on("end", () => {
      // After extracting subtitles, read the generated WebVTT file
      const subtitlePath = inputPath + ".vtt"; // The file will be saved as .vtt

      fs.readFile(subtitlePath, "utf8", (err, data) => {
        if (err) {
          console.error("Error reading subtitle file:", err);
          return res.status(500).send("Error reading subtitle file");
        }

        // Send the subtitle data as JSON
        res.status(200).send(data)

        // Optionally, delete the temporary subtitle file after reading
        fs.unlink(subtitlePath, (err) => {
          if (err) console.error("Error deleting subtitle file:", err);
        });
      });
    })
    .on("error", (err) => {
      console.error("Error extracting subtitles:", err);
      res.status(500).send("Error extracting subtitles: \n" + err);
    })
    .save(inputPath + ".vtt");  // Save the subtitle as .vtt
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"))
})