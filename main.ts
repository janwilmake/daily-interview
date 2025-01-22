/// <reference types="@cloudflare/workers-types" />
/**
phone call streamer is initiated but 
*/
import { createStreamPhonecall } from "./createStreamPhonecall";

export interface Env {
  OPENAI_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  TARGET_PHONE_NUMBER: string;
  WORKER_HOST: string;
}

interface TwilioMediaMessage {
  event: string;
  media?: {
    payload: string;
    timestamp: number;
  };
  start?: {
    streamSid: string;
  };
  mark?: {
    name: string;
  };
}

interface OpenAIEvent {
  type: string;
  delta?: string;
  item_id?: string;
  [key: string]: any;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/test") {
      const streamUrl = `wss://${env.WORKER_HOST}/media-stream`;
      console.log({ streamUrl });
      const result = await createStreamPhonecall({
        twilioAccountSid: env.TWILIO_ACCOUNT_SID,
        twilioAuthToken: env.TWILIO_AUTH_TOKEN,
        phoneNumber: env.TARGET_PHONE_NUMBER,
        streamUrl,
        fromNumber: env.TWILIO_FROM_NUMBER,
      });
      return new Response(JSON.stringify(result, undefined, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    // Handle incoming call webhook
    if (url.pathname === "/incoming-call") {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                    <Pause length="1"/>
                    <Say>O.K. you can start talking!</Say>
                    <Connect>
                        <Stream url="wss://${env.WORKER_HOST}/media-stream" />
                    </Connect>
                </Response>`;

      return new Response(twiml, {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Handle WebSocket upgrade for media stream
    if (url.pathname === "/media-stream") {
      console.log("RECEIVED /media-stream");
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      handleServerWebSocket(server, env);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Trigger the phone call through Twilio
    const result = await createStreamPhonecall({
      twilioAccountSid: env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: env.TWILIO_AUTH_TOKEN,
      phoneNumber: env.TARGET_PHONE_NUMBER,
      streamUrl: `wss://${env.WORKER_HOST}/media-stream`,
      fromNumber: env.TWILIO_FROM_NUMBER,
    });

    if (!result.isSuccessful) {
      throw new Error(`Failed to initiate call: ${result.message}`);
    }

    console.log(`Call initiated successfully: ${result.callSid}`);
  },
};

function handleServerWebSocket(twilioWebsocket: WebSocket, env: Env) {
  twilioWebsocket.accept();

  const audioQueue: any[] = [];
  const SYSTEM_MESSAGE = "You are a helpful and bubbly AI assistant..."; // Keep your original message
  const VOICE = "alloy";
  const LOG_EVENT_TYPES = ["error", "response.content.done"];
  let openAiWs: WebSocket;
  let twilioWebsocketStreamSid: string | null = null;

  async function handleTwilioWebSocket() {
    const BUFFER_SIZE = 20 * 160;
    let inbuffer: Uint8Array = new Uint8Array(0);

    twilioWebsocket.addEventListener("message", async (event) => {
      const data = JSON.parse(event.data as string);
      if (data.event === "start") {
        const start = data.start;
        console.log("got our streamsid", twilioWebsocketStreamSid);
        twilioWebsocketStreamSid = start.streamSid;
      }
      if (data.event === "connected") {
        return;
      }
      if (data.event === "media") {
        const media = data.media;
        const chunk = new Uint8Array(
          atob(media.payload)
            .split("")
            .map((char) => char.charCodeAt(0)),
        );
        if (media.track === "inbound") {
          const newBuffer = new Uint8Array(inbuffer.length + chunk.length);
          newBuffer.set(inbuffer);
          newBuffer.set(chunk, inbuffer.length);
          inbuffer = newBuffer;
        }
      }
      if (data.event === "stop") {
        return;
      }

      while (inbuffer.length >= BUFFER_SIZE) {
        const chunk = inbuffer.slice(0, BUFFER_SIZE);
        audioQueue.push(chunk);
        inbuffer = inbuffer.slice(BUFFER_SIZE);

        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.send(chunk.buffer);
        } else {
          console.warn("STS WebSocket not open, cannot send chunk");
        }
      }
    });

    twilioWebsocket.addEventListener("close", () => {
      openAiWs.close();
      console.log("Twilio connection closed");
    });
  }

  async function handleOpenAiWs() {
    openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      [
        "realtime",
        // Auth
        "openai-insecure-api-key." + env.OPENAI_API_KEY,
        // Beta protocol, required
        "openai-beta.realtime-v1",
      ],
    );
    openAiWs.addEventListener("open", () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    });

    openAiWs.addEventListener("message", async (event) => {
      const message = event.data;

      if (typeof message === "string") {
        // this logs what is happening
        console.log(message);
        return;
      }

      const rawMulaw = message;
      const mulawString = String.fromCharCode(...new Uint8Array(rawMulaw));
      const mediaMessage = {
        event: "media",
        streamSid: twilioWebsocketStreamSid,
        media: { payload: btoa(mulawString) },
      };

      twilioWebsocket.send(JSON.stringify(mediaMessage));
    });

    openAiWs.addEventListener("close", () => {
      twilioWebsocket.close();
      console.log("OpenAI connection closed");
    });
  }

  // let latestMediaTimestamp = 0;
  // let lastAssistantItem: string | null = null;
  // let markQueue: string[] = [];
  // let responseStartTimestampTwilio: number | null = null;

  // Create OpenAI WebSocket connection

  // openAiWs.addEventListener("message", (event) => {
  //   try {
  //     const response: OpenAIEvent = JSON.parse(event.data);

  //     if (LOG_EVENT_TYPES.includes(response.type)) {
  //       console.log("OpenAI Event:", response.type, response);
  //     }

  //     if (response.type === "response.audio.delta" && response.delta) {
  //       const audioDelta = {
  //         event: "media",
  //         streamSid: streamSid,
  //         media: { payload: response.delta },
  //       };
  //       server.send(JSON.stringify(audioDelta));

  //       if (!responseStartTimestampTwilio) {
  //         responseStartTimestampTwilio = latestMediaTimestamp;
  //       }
  //       if (response.item_id) lastAssistantItem = response.item_id;

  //       sendMark(server, streamSid);
  //     }

  //     if (response.type === "input_audio_buffer.speech_started") {
  //       handleSpeechStarted();
  //     }
  //   } catch (error) {
  //     console.error("OpenAI message error:", error);
  //   }
  // });

  // Twilio WebSocket handlers
  // server.addEventListener("message", (event) => {
  //   try {
  //     const data: TwilioMediaMessage = JSON.parse(event.data.toString());

  //     switch (data.event) {
  //       case "media":
  //         latestMediaTimestamp = data.media!.timestamp;
  //         if (openAiWs.readyState === WebSocket.OPEN) {
  //           openAiWs.send(
  //             JSON.stringify({
  //               type: "input_audio_buffer.append",
  //               audio: data.media!.payload,
  //             }),
  //           );
  //         }
  //         break;
  //       case "start":
  //         streamSid = data.start!.streamSid;
  //         console.log("Stream started:", streamSid);
  //         responseStartTimestampTwilio = null;
  //         latestMediaTimestamp = 0;
  //         break;
  //       case "mark":
  //         markQueue.shift();
  //         break;
  //     }
  //   } catch (error) {
  //     console.error("Twilio message error:", error);
  //   }
  // });

  // Helper functions
  // function handleSpeechStarted() {
  //   if (markQueue.length > 0 && responseStartTimestampTwilio !== null) {
  //     const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
  //     if (lastAssistantItem) {
  //       openAiWs.send(
  //         JSON.stringify({
  //           type: "conversation.item.truncate",
  //           item_id: lastAssistantItem,
  //           content_index: 0,
  //           audio_end_ms: elapsedTime,
  //         }),
  //       );
  //     }
  //     server.send(
  //       JSON.stringify({
  //         event: "clear",
  //         streamSid: streamSid,
  //       }),
  //     );
  //     markQueue = [];
  //     lastAssistantItem = null;
  //     responseStartTimestampTwilio = null;
  //   }
  // }

  // function sendMark(connection: WebSocket, streamSid: string | null) {
  //   if (streamSid) {
  //     const markEvent = {
  //       event: "mark",
  //       streamSid: streamSid,
  //       mark: { name: "responsePart" },
  //     };
  //     connection.send(JSON.stringify(markEvent));
  //     markQueue.push("responsePart");
  //   }
  // }

  // Cleanup handlers
  // server.addEventListener("close", () => {
  //   openAiWs.close();
  //   console.log("Twilio connection closed");
  // });

  // openAiWs.addEventListener("close", () => {
  //   server.close();
  //   console.log("OpenAI connection closed");
  // });
}

// used in deepgram
// function handleWebSocketSession(webSocket: WebSocket, agentSlug: string) {
//   webSocket.accept();

//   const configMessage = {
//     type: "SettingsConfiguration",
//     audio: {
//       input: {
//         encoding: "mulaw",
//         sample_rate: 8000,
//       },
//       output: {
//         encoding: "mulaw",
//         sample_rate: 8000,
//         container: "none",
//         buffer_size: 250,
//       },
//     },
//     agent: {
//       listen: {
//         model: "nova-2",
//       },
//       think: {
//         provider: "open_ai",
//         model: "gpt-4o",
//         instructions:
//           "You are a helpful voice assistant. You cannot perform actions, but you have expert knowledge. Please be as concise as possible.",
//         functions: [],
//       },
//       speak: {
//         model: "aura-asteria-en",
//       },
//     },
//   };

//   const audioQueue: any[] = [];
//   let streamSid: undefined | string = undefined;

//   let stsWs: WebSocket | null = null;

//   function connectToSts() {
//     return new WebSocket(agentWsUrl, ["token", deepgramToken]);
//   }

//   async function handleStsWebSocket() {
//     stsWs = connectToSts();
//     stsWs.addEventListener("open", () => {
//       stsWs?.send(JSON.stringify(configMessage));
//     });

//     stsWs.addEventListener("message", async (event) => {
//       const message = event.data;

//       if (typeof message === "string") {
//         // this logs what is happening
//         console.log(message);
//         return;
//       }

//       const rawMulaw = message;
//       const mulawString = String.fromCharCode(...new Uint8Array(rawMulaw));
//       const mediaMessage = {
//         event: "media",
//         streamSid,
//         media: { payload: btoa(mulawString) },
//       };

//       webSocket.send(JSON.stringify(mediaMessage));
//     });
//   }

// async function handleTwilioWebSocket() {
//   const BUFFER_SIZE = 20 * 160;
//   let inbuffer: Uint8Array = new Uint8Array(0);

//   webSocket.addEventListener("message", async (event) => {
//     const data = JSON.parse(event.data as string);
//     if (data.event === "start") {
//       const start = data.start;
//       console.log("got our streamsid", streamSid);
//       streamSid = start.streamSid;
//     }
//     if (data.event === "connected") {
//       return;
//     }
//     if (data.event === "media") {
//       const media = data.media;
//       const chunk = new Uint8Array(
//         atob(media.payload)
//           .split("")
//           .map((char) => char.charCodeAt(0)),
//       );
//       if (media.track === "inbound") {
//         const newBuffer = new Uint8Array(inbuffer.length + chunk.length);
//         newBuffer.set(inbuffer);
//         newBuffer.set(chunk, inbuffer.length);
//         inbuffer = newBuffer;
//       }
//     }
//     if (data.event === "stop") {
//       return;
//     }

//     while (inbuffer.length >= BUFFER_SIZE) {
//       const chunk = inbuffer.slice(0, BUFFER_SIZE);
//       audioQueue.push(chunk);
//       inbuffer = inbuffer.slice(BUFFER_SIZE);

//       if (stsWs && stsWs.readyState === WebSocket.OPEN) {
//         stsWs.send(chunk.buffer);
//       } else {
//         console.warn("STS WebSocket not open, cannot send chunk");
//       }
//     }
//   });
// }

//   handleStsWebSocket();
//   handleTwilioWebSocket();
// }
