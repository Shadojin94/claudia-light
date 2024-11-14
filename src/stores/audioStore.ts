import { create } from "/node_modules/.vite/deps/zustand.js?v=367680fb";
import OpenAI from "/node_modules/.vite/deps/openai.js?v=98fa7bcc";
import { CONFIG } from "/src/config.js";
const openai = new OpenAI({
  apiKey: CONFIG.OPENAI_API_KEY,
  dangerouslyAllowBrowser: true
});
export const useAudioStore = create((set, get) => ({
  isListening: false,
  isAISpeaking: false,
  isActiveMode: false,
  isAgentMode: false,
  aiResponse: "",
  sessionStartTime: null,
  currentThread: null,
  showDownloadModal: false,
  audioQueue: [],
  recognition: null,
  initSpeechRecognition: () => {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      console.error("Speech recognition not supported");
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "fr-FR";
    recognition.onstart = () => {
      if (!get().sessionStartTime) {
        set({ sessionStartTime: Date.now() });
      }
      set({ isListening: true });
    };
    recognition.onresult = (event) => {
      const result = event.results[0][0].transcript;
      if (result.trim()) {
        get().sendMessage(result);
      }
    };
    recognition.onend = () => {
      set({ isListening: false });
      const state = get();
      if (state.isActiveMode && !state.isAISpeaking) {
        setTimeout(() => {
          const currentState = get();
          if (currentState.isActiveMode && !currentState.isAISpeaking) {
            currentState.startListening();
          }
        }, 100);
      }
    };
    recognition.onerror = () => {
      set({ isListening: false });
    };
    set({ recognition });
  },
  startListening: () => {
    const state = get();
    if (state.isAISpeaking || state.isListening) return;
    if (!state.recognition) {
      state.initSpeechRecognition();
    }
    try {
      state.recognition?.start();
    } catch (error) {
      console.error("Error starting recognition:", error);
      set({ isListening: false });
      setTimeout(() => get().startListening(), 100);
    }
  },
  stopListening: () => {
    const state = get();
    if (state.recognition) {
      try {
        state.recognition.stop();
      } catch (error) {
        console.error("Error stopping recognition:", error);
      }
    }
    set({ isListening: false });
  },
  toggleActiveMode: () => {
    const state = get();
    const newActiveMode = !state.isActiveMode;
    set({ isActiveMode: newActiveMode });
    if (newActiveMode && !state.isListening && !state.isAISpeaking) {
      state.startListening();
    } else if (!newActiveMode) {
      state.stopListening();
    }
  },
  setAIResponse: (response) => set({ aiResponse: response }),
  handleImageUpload: async (file) => {
    try {
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result);
        reader.readAsDataURL(file);
      });
      const response = await openai.chat.completions.create({
        model: "gpt-4-vision-preview",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Que voyez-vous dans cette image ?" },
              { type: "image_url", image_url: { url: base64 } }
            ]
          }
        ]
      });
      const description = response.choices[0].message.content;
      set({ aiResponse: description });
      get().addToAudioQueue(description);
    } catch (error) {
      console.error("Error processing image:", error);
      set({ aiResponse: "Désolé, une erreur est survenue lors de l'analyse de l'image." });
    }
  },
  startAgentChat: async () => {
    try {
      const response = await openai.beta.threads.create();
      set({
        currentThread: response.id,
        isAgentMode: true,
        aiResponse: "Bonjour, je suis votre agent assistant. Comment puis-je vous aider ?"
      });
    } catch (error) {
      console.error("Error starting agent chat:", error);
      set({ aiResponse: "Désolé, impossible de démarrer la conversation avec l'agent." });
    }
  },
  sendMessage: async (message) => {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: message }]
      });
      const reply = response.choices[0].message.content;
      set({ aiResponse: reply });
      get().addToAudioQueue(reply);
    } catch (error) {
      console.error("Error sending message:", error);
      set({ aiResponse: "Désolé, une erreur est survenue lors de l'envoi du message." });
    }
  },
  sendMessageToAgent: async (message) => {
    const thread = get().currentThread;
    if (!thread) {
      set({ aiResponse: "Erreur: Aucune conversation active avec l'agent." });
      return;
    }
    try {
      await openai.beta.threads.messages.create(thread, {
        role: "user",
        content: message
      });
      const run = await openai.beta.threads.runs.create(thread, {
        assistant_id: "asst_JaH2MRCLxltrsI34qa7gQ5RP"
      });
      let response = await openai.beta.threads.runs.retrieve(thread, run.id);
      while (response.status === "queued" || response.status === "in_progress") {
        await new Promise((resolve) => setTimeout(resolve, 1e3));
        response = await openai.beta.threads.runs.retrieve(thread, run.id);
      }
      const messages = await openai.beta.threads.messages.list(thread);
      const lastMessage = messages.data[0];
      const reply = lastMessage.content[0].text.value;
      set({ aiResponse: reply });
      get().addToAudioQueue(reply);
    } catch (error) {
      console.error("Error sending message to agent:", error);
      set({ aiResponse: "Désolé, une erreur est survenue lors de la communication avec l'agent." });
    }
  },
  toggleDownloadModal: () => set((state) => ({ showDownloadModal: !state.showDownloadModal })),
  addToAudioQueue: (text) => {
    set((state) => ({ audioQueue: [...state.audioQueue, text] }));
    if (!get().isAISpeaking) {
      get().playNextInQueue();
    }
  },
  playNextInQueue: async () => {
    const state = get();
    if (state.audioQueue.length === 0 || state.isAISpeaking) return;
    const text = state.audioQueue[0];
    set({ isAISpeaking: true });
    try {
      const response = await openai.audio.speech.create({
        model: "tts-1",
        voice: "nova",
        input: text
      });
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.onended = () => {
        set((state2) => ({
          isAISpeaking: false,
          audioQueue: state2.audioQueue.slice(1)
        }));
        URL.revokeObjectURL(audioUrl);
        get().playNextInQueue();
        const currentState = get();
        if (currentState.isActiveMode && !currentState.isListening) {
          setTimeout(() => currentState.startListening(), 100);
        }
      };
      await audio.play();
    } catch (error) {
      console.error("Error playing audio:", error);
      set((state2) => ({
        isAISpeaking: false,
        audioQueue: state2.audioQueue.slice(1)
      }));
      get().playNextInQueue();
    }
  }
}));

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImF1ZGlvU3RvcmUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlIH0gZnJvbSAnenVzdGFuZCc7XG5pbXBvcnQgT3BlbkFJIGZyb20gJ29wZW5haSc7XG5pbXBvcnQgeyBDT05GSUcgfSBmcm9tICcuLi9jb25maWcnO1xuXG5jb25zdCBvcGVuYWkgPSBuZXcgT3BlbkFJKHtcbiAgYXBpS2V5OiBDT05GSUcuT1BFTkFJX0FQSV9LRVksXG4gIGRhbmdlcm91c2x5QWxsb3dCcm93c2VyOiB0cnVlXG59KTtcblxuaW50ZXJmYWNlIEF1ZGlvU3RhdGUge1xuICBpc0xpc3RlbmluZzogYm9vbGVhbjtcbiAgaXNBSVNwZWFraW5nOiBib29sZWFuO1xuICBpc0FjdGl2ZU1vZGU6IGJvb2xlYW47XG4gIGlzQWdlbnRNb2RlOiBib29sZWFuO1xuICBhaVJlc3BvbnNlOiBzdHJpbmc7XG4gIHNlc3Npb25TdGFydFRpbWU6IG51bWJlciB8IG51bGw7XG4gIGN1cnJlbnRUaHJlYWQ6IHN0cmluZyB8IG51bGw7XG4gIHNob3dEb3dubG9hZE1vZGFsOiBib29sZWFuO1xuICBhdWRpb1F1ZXVlOiBzdHJpbmdbXTtcbiAgcmVjb2duaXRpb246IFNwZWVjaFJlY29nbml0aW9uIHwgbnVsbDtcblxuICBzdGFydExpc3RlbmluZzogKCkgPT4gdm9pZDtcbiAgc3RvcExpc3RlbmluZzogKCkgPT4gdm9pZDtcbiAgdG9nZ2xlQWN0aXZlTW9kZTogKCkgPT4gdm9pZDtcbiAgc2V0QUlSZXNwb25zZTogKHJlc3BvbnNlOiBzdHJpbmcpID0+IHZvaWQ7XG4gIGhhbmRsZUltYWdlVXBsb2FkOiAoZmlsZTogRmlsZSkgPT4gUHJvbWlzZTx2b2lkPjtcbiAgc3RhcnRBZ2VudENoYXQ6ICgpID0+IFByb21pc2U8dm9pZD47XG4gIHNlbmRNZXNzYWdlOiAobWVzc2FnZTogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+O1xuICBzZW5kTWVzc2FnZVRvQWdlbnQ6IChtZXNzYWdlOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG4gIHRvZ2dsZURvd25sb2FkTW9kYWw6ICgpID0+IHZvaWQ7XG4gIGFkZFRvQXVkaW9RdWV1ZTogKHRleHQ6IHN0cmluZykgPT4gdm9pZDtcbiAgcGxheU5leHRJblF1ZXVlOiAoKSA9PiB2b2lkO1xuICBpbml0U3BlZWNoUmVjb2duaXRpb246ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBjb25zdCB1c2VBdWRpb1N0b3JlID0gY3JlYXRlPEF1ZGlvU3RhdGU+KChzZXQsIGdldCkgPT4gKHtcbiAgaXNMaXN0ZW5pbmc6IGZhbHNlLFxuICBpc0FJU3BlYWtpbmc6IGZhbHNlLFxuICBpc0FjdGl2ZU1vZGU6IGZhbHNlLFxuICBpc0FnZW50TW9kZTogZmFsc2UsXG4gIGFpUmVzcG9uc2U6ICcnLFxuICBzZXNzaW9uU3RhcnRUaW1lOiBudWxsLFxuICBjdXJyZW50VGhyZWFkOiBudWxsLFxuICBzaG93RG93bmxvYWRNb2RhbDogZmFsc2UsXG4gIGF1ZGlvUXVldWU6IFtdLFxuICByZWNvZ25pdGlvbjogbnVsbCxcblxuICBpbml0U3BlZWNoUmVjb2duaXRpb246ICgpID0+IHtcbiAgICBpZiAoISgnd2Via2l0U3BlZWNoUmVjb2duaXRpb24nIGluIHdpbmRvdykgJiYgISgnU3BlZWNoUmVjb2duaXRpb24nIGluIHdpbmRvdykpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1NwZWVjaCByZWNvZ25pdGlvbiBub3Qgc3VwcG9ydGVkJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgU3BlZWNoUmVjb2duaXRpb24gPSB3aW5kb3cuU3BlZWNoUmVjb2duaXRpb24gfHwgd2luZG93LndlYmtpdFNwZWVjaFJlY29nbml0aW9uO1xuICAgIGNvbnN0IHJlY29nbml0aW9uID0gbmV3IFNwZWVjaFJlY29nbml0aW9uKCk7XG5cbiAgICByZWNvZ25pdGlvbi5jb250aW51b3VzID0gZmFsc2U7XG4gICAgcmVjb2duaXRpb24uaW50ZXJpbVJlc3VsdHMgPSBmYWxzZTtcbiAgICByZWNvZ25pdGlvbi5sYW5nID0gJ2ZyLUZSJztcblxuICAgIHJlY29nbml0aW9uLm9uc3RhcnQgPSAoKSA9PiB7XG4gICAgICBpZiAoIWdldCgpLnNlc3Npb25TdGFydFRpbWUpIHtcbiAgICAgICAgc2V0KHsgc2Vzc2lvblN0YXJ0VGltZTogRGF0ZS5ub3coKSB9KTtcbiAgICAgIH1cbiAgICAgIHNldCh7IGlzTGlzdGVuaW5nOiB0cnVlIH0pO1xuICAgIH07XG5cbiAgICByZWNvZ25pdGlvbi5vbnJlc3VsdCA9IChldmVudCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZXZlbnQucmVzdWx0c1swXVswXS50cmFuc2NyaXB0O1xuICAgICAgaWYgKHJlc3VsdC50cmltKCkpIHtcbiAgICAgICAgZ2V0KCkuc2VuZE1lc3NhZ2UocmVzdWx0KTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgcmVjb2duaXRpb24ub25lbmQgPSAoKSA9PiB7XG4gICAgICBzZXQoeyBpc0xpc3RlbmluZzogZmFsc2UgfSk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGdldCgpO1xuICAgICAgaWYgKHN0YXRlLmlzQWN0aXZlTW9kZSAmJiAhc3RhdGUuaXNBSVNwZWFraW5nKSB7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGN1cnJlbnRTdGF0ZSA9IGdldCgpO1xuICAgICAgICAgIGlmIChjdXJyZW50U3RhdGUuaXNBY3RpdmVNb2RlICYmICFjdXJyZW50U3RhdGUuaXNBSVNwZWFraW5nKSB7XG4gICAgICAgICAgICBjdXJyZW50U3RhdGUuc3RhcnRMaXN0ZW5pbmcoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0sIDEwMCk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIHJlY29nbml0aW9uLm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICBzZXQoeyBpc0xpc3RlbmluZzogZmFsc2UgfSk7XG4gICAgfTtcblxuICAgIHNldCh7IHJlY29nbml0aW9uIH0pO1xuICB9LFxuXG4gIHN0YXJ0TGlzdGVuaW5nOiAoKSA9PiB7XG4gICAgY29uc3Qgc3RhdGUgPSBnZXQoKTtcbiAgICBpZiAoc3RhdGUuaXNBSVNwZWFraW5nIHx8IHN0YXRlLmlzTGlzdGVuaW5nKSByZXR1cm47XG5cbiAgICBpZiAoIXN0YXRlLnJlY29nbml0aW9uKSB7XG4gICAgICBzdGF0ZS5pbml0U3BlZWNoUmVjb2duaXRpb24oKTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgc3RhdGUucmVjb2duaXRpb24/LnN0YXJ0KCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHN0YXJ0aW5nIHJlY29nbml0aW9uOicsIGVycm9yKTtcbiAgICAgIHNldCh7IGlzTGlzdGVuaW5nOiBmYWxzZSB9KTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gZ2V0KCkuc3RhcnRMaXN0ZW5pbmcoKSwgMTAwKTtcbiAgICB9XG4gIH0sXG5cbiAgc3RvcExpc3RlbmluZzogKCkgPT4ge1xuICAgIGNvbnN0IHN0YXRlID0gZ2V0KCk7XG4gICAgaWYgKHN0YXRlLnJlY29nbml0aW9uKSB7XG4gICAgICB0cnkge1xuICAgICAgICBzdGF0ZS5yZWNvZ25pdGlvbi5zdG9wKCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBzdG9wcGluZyByZWNvZ25pdGlvbjonLCBlcnJvcik7XG4gICAgICB9XG4gICAgfVxuICAgIHNldCh7IGlzTGlzdGVuaW5nOiBmYWxzZSB9KTtcbiAgfSxcblxuICB0b2dnbGVBY3RpdmVNb2RlOiAoKSA9PiB7XG4gICAgY29uc3Qgc3RhdGUgPSBnZXQoKTtcbiAgICBjb25zdCBuZXdBY3RpdmVNb2RlID0gIXN0YXRlLmlzQWN0aXZlTW9kZTtcbiAgICBzZXQoeyBpc0FjdGl2ZU1vZGU6IG5ld0FjdGl2ZU1vZGUgfSk7XG4gICAgXG4gICAgaWYgKG5ld0FjdGl2ZU1vZGUgJiYgIXN0YXRlLmlzTGlzdGVuaW5nICYmICFzdGF0ZS5pc0FJU3BlYWtpbmcpIHtcbiAgICAgIHN0YXRlLnN0YXJ0TGlzdGVuaW5nKCk7XG4gICAgfSBlbHNlIGlmICghbmV3QWN0aXZlTW9kZSkge1xuICAgICAgc3RhdGUuc3RvcExpc3RlbmluZygpO1xuICAgIH1cbiAgfSxcblxuICBzZXRBSVJlc3BvbnNlOiAocmVzcG9uc2U6IHN0cmluZykgPT4gc2V0KHsgYWlSZXNwb25zZTogcmVzcG9uc2UgfSksXG5cbiAgaGFuZGxlSW1hZ2VVcGxvYWQ6IGFzeW5jIChmaWxlOiBGaWxlKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJhc2U2NCA9IGF3YWl0IG5ldyBQcm9taXNlPHN0cmluZz4oKHJlc29sdmUpID0+IHtcbiAgICAgICAgY29uc3QgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcbiAgICAgICAgcmVhZGVyLm9ubG9hZCA9IChlKSA9PiByZXNvbHZlKGUudGFyZ2V0Py5yZXN1bHQgYXMgc3RyaW5nKTtcbiAgICAgICAgcmVhZGVyLnJlYWRBc0RhdGFVUkwoZmlsZSk7XG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBvcGVuYWkuY2hhdC5jb21wbGV0aW9ucy5jcmVhdGUoe1xuICAgICAgICBtb2RlbDogXCJncHQtNC12aXNpb24tcHJldmlld1wiLFxuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlF1ZSB2b3llei12b3VzIGRhbnMgY2V0dGUgaW1hZ2UgP1wiIH0sXG4gICAgICAgICAgICAgIHsgdHlwZTogXCJpbWFnZV91cmxcIiwgaW1hZ2VfdXJsOiB7IHVybDogYmFzZTY0IH0gfVxuICAgICAgICAgICAgXVxuICAgICAgICAgIH1cbiAgICAgICAgXVxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gcmVzcG9uc2UuY2hvaWNlc1swXS5tZXNzYWdlLmNvbnRlbnQ7XG4gICAgICBzZXQoeyBhaVJlc3BvbnNlOiBkZXNjcmlwdGlvbiB9KTtcbiAgICAgIGdldCgpLmFkZFRvQXVkaW9RdWV1ZShkZXNjcmlwdGlvbik7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHByb2Nlc3NpbmcgaW1hZ2U6JywgZXJyb3IpO1xuICAgICAgc2V0KHsgYWlSZXNwb25zZTogXCJEw6lzb2zDqSwgdW5lIGVycmV1ciBlc3Qgc3VydmVudWUgbG9ycyBkZSBsJ2FuYWx5c2UgZGUgbCdpbWFnZS5cIiB9KTtcbiAgICB9XG4gIH0sXG5cbiAgc3RhcnRBZ2VudENoYXQ6IGFzeW5jICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBvcGVuYWkuYmV0YS50aHJlYWRzLmNyZWF0ZSgpO1xuICAgICAgc2V0KHsgXG4gICAgICAgIGN1cnJlbnRUaHJlYWQ6IHJlc3BvbnNlLmlkLFxuICAgICAgICBpc0FnZW50TW9kZTogdHJ1ZSxcbiAgICAgICAgYWlSZXNwb25zZTogXCJCb25qb3VyLCBqZSBzdWlzIHZvdHJlIGFnZW50IGFzc2lzdGFudC4gQ29tbWVudCBwdWlzLWplIHZvdXMgYWlkZXIgP1wiXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcignRXJyb3Igc3RhcnRpbmcgYWdlbnQgY2hhdDonLCBlcnJvcik7XG4gICAgICBzZXQoeyBhaVJlc3BvbnNlOiBcIkTDqXNvbMOpLCBpbXBvc3NpYmxlIGRlIGTDqW1hcnJlciBsYSBjb252ZXJzYXRpb24gYXZlYyBsJ2FnZW50LlwiIH0pO1xuICAgIH1cbiAgfSxcblxuICBzZW5kTWVzc2FnZTogYXN5bmMgKG1lc3NhZ2U6IHN0cmluZykgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IG9wZW5haS5jaGF0LmNvbXBsZXRpb25zLmNyZWF0ZSh7XG4gICAgICAgIG1vZGVsOiBcImdwdC00by1taW5pXCIsXG4gICAgICAgIG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogbWVzc2FnZSB9XVxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlcGx5ID0gcmVzcG9uc2UuY2hvaWNlc1swXS5tZXNzYWdlLmNvbnRlbnQ7XG4gICAgICBzZXQoeyBhaVJlc3BvbnNlOiByZXBseSB9KTtcbiAgICAgIGdldCgpLmFkZFRvQXVkaW9RdWV1ZShyZXBseSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHNlbmRpbmcgbWVzc2FnZTonLCBlcnJvcik7XG4gICAgICBzZXQoeyBhaVJlc3BvbnNlOiBcIkTDqXNvbMOpLCB1bmUgZXJyZXVyIGVzdCBzdXJ2ZW51ZSBsb3JzIGRlIGwnZW52b2kgZHUgbWVzc2FnZS5cIiB9KTtcbiAgICB9XG4gIH0sXG5cbiAgc2VuZE1lc3NhZ2VUb0FnZW50OiBhc3luYyAobWVzc2FnZTogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgdGhyZWFkID0gZ2V0KCkuY3VycmVudFRocmVhZDtcbiAgICBpZiAoIXRocmVhZCkge1xuICAgICAgc2V0KHsgYWlSZXNwb25zZTogXCJFcnJldXI6IEF1Y3VuZSBjb252ZXJzYXRpb24gYWN0aXZlIGF2ZWMgbCdhZ2VudC5cIiB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgb3BlbmFpLmJldGEudGhyZWFkcy5tZXNzYWdlcy5jcmVhdGUodGhyZWFkLCB7XG4gICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICBjb250ZW50OiBtZXNzYWdlXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcnVuID0gYXdhaXQgb3BlbmFpLmJldGEudGhyZWFkcy5ydW5zLmNyZWF0ZSh0aHJlYWQsIHtcbiAgICAgICAgYXNzaXN0YW50X2lkOiBcImFzc3RfSmFIMk1SQ0x4bHRyc0kzNHFhN2dRNVJQXCJcbiAgICAgIH0pO1xuXG4gICAgICAgIGxldCByZXNwb25zZSA9IGF3YWl0IG9wZW5haS5iZXRhLnRocmVhZHMucnVucy5yZXRyaWV2ZSh0aHJlYWQsIHJ1bi5pZCk7XG4gICAgICB3aGlsZSAocmVzcG9uc2Uuc3RhdHVzID09PSBcInF1ZXVlZFwiIHx8IHJlc3BvbnNlLnN0YXR1cyA9PT0gXCJpbl9wcm9ncmVzc1wiKSB7XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxMDAwKSk7XG4gICAgICAgIHJlc3BvbnNlID0gYXdhaXQgb3BlbmFpLmJldGEudGhyZWFkcy5ydW5zLnJldHJpZXZlKHRocmVhZCwgcnVuLmlkKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWVzc2FnZXMgPSBhd2FpdCBvcGVuYWkuYmV0YS50aHJlYWRzLm1lc3NhZ2VzLmxpc3QodGhyZWFkKTtcbiAgICAgIGNvbnN0IGxhc3RNZXNzYWdlID0gbWVzc2FnZXMuZGF0YVswXTtcbiAgICAgIGNvbnN0IHJlcGx5ID0gbGFzdE1lc3NhZ2UuY29udGVudFswXS50ZXh0LnZhbHVlO1xuXG4gICAgICBzZXQoeyBhaVJlc3BvbnNlOiByZXBseSB9KTtcbiAgICAgIGdldCgpLmFkZFRvQXVkaW9RdWV1ZShyZXBseSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHNlbmRpbmcgbWVzc2FnZSB0byBhZ2VudDonLCBlcnJvcik7XG4gICAgICBzZXQoeyBhaVJlc3BvbnNlOiBcIkTDqXNvbMOpLCB1bmUgZXJyZXVyIGVzdCBzdXJ2ZW51ZSBsb3JzIGRlIGxhIGNvbW11bmljYXRpb24gYXZlYyBsJ2FnZW50LlwiIH0pO1xuICAgIH1cbiAgfSxcblxuICB0b2dnbGVEb3dubG9hZE1vZGFsOiAoKSA9PiBzZXQoc3RhdGUgPT4gKHsgc2hvd0Rvd25sb2FkTW9kYWw6ICFzdGF0ZS5zaG93RG93bmxvYWRNb2RhbCB9KSksXG5cbiAgYWRkVG9BdWRpb1F1ZXVlOiAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgc2V0KHN0YXRlID0+ICh7IGF1ZGlvUXVldWU6IFsuLi5zdGF0ZS5hdWRpb1F1ZXVlLCB0ZXh0XSB9KSk7XG4gICAgaWYgKCFnZXQoKS5pc0FJU3BlYWtpbmcpIHtcbiAgICAgIGdldCgpLnBsYXlOZXh0SW5RdWV1ZSgpO1xuICAgIH1cbiAgfSxcblxuICBwbGF5TmV4dEluUXVldWU6IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdGF0ZSA9IGdldCgpO1xuICAgIGlmIChzdGF0ZS5hdWRpb1F1ZXVlLmxlbmd0aCA9PT0gMCB8fCBzdGF0ZS5pc0FJU3BlYWtpbmcpIHJldHVybjtcblxuICAgIGNvbnN0IHRleHQgPSBzdGF0ZS5hdWRpb1F1ZXVlWzBdO1xuICAgIHNldCh7IGlzQUlTcGVha2luZzogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IG9wZW5haS5hdWRpby5zcGVlY2guY3JlYXRlKHtcbiAgICAgICAgbW9kZWw6IFwidHRzLTFcIixcbiAgICAgICAgdm9pY2U6IFwibm92YVwiLFxuICAgICAgICBpbnB1dDogdGV4dFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGF1ZGlvQmxvYiA9IGF3YWl0IHJlc3BvbnNlLmJsb2IoKTtcbiAgICAgIGNvbnN0IGF1ZGlvVXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChhdWRpb0Jsb2IpO1xuICAgICAgY29uc3QgYXVkaW8gPSBuZXcgQXVkaW8oYXVkaW9VcmwpO1xuXG4gICAgICBhdWRpby5vbmVuZGVkID0gKCkgPT4ge1xuICAgICAgICBzZXQoc3RhdGUgPT4gKHsgXG4gICAgICAgICAgaXNBSVNwZWFraW5nOiBmYWxzZSxcbiAgICAgICAgICBhdWRpb1F1ZXVlOiBzdGF0ZS5hdWRpb1F1ZXVlLnNsaWNlKDEpXG4gICAgICAgIH0pKTtcbiAgICAgICAgVVJMLnJldm9rZU9iamVjdFVSTChhdWRpb1VybCk7XG4gICAgICAgIGdldCgpLnBsYXlOZXh0SW5RdWV1ZSgpO1xuXG4gICAgICAgIC8vIFJlZMOpbWFycmVyIGwnw6ljb3V0ZSBzaSBsZSBtb2RlIGFjdGlmIGVzdCBhY3RpdsOpXG4gICAgICAgIGNvbnN0IGN1cnJlbnRTdGF0ZSA9IGdldCgpO1xuICAgICAgICBpZiAoY3VycmVudFN0YXRlLmlzQWN0aXZlTW9kZSAmJiAhY3VycmVudFN0YXRlLmlzTGlzdGVuaW5nKSB7XG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiBjdXJyZW50U3RhdGUuc3RhcnRMaXN0ZW5pbmcoKSwgMTAwKTtcbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgYXdhaXQgYXVkaW8ucGxheSgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBwbGF5aW5nIGF1ZGlvOicsIGVycm9yKTtcbiAgICAgIHNldChzdGF0ZSA9PiAoeyBcbiAgICAgICAgaXNBSVNwZWFraW5nOiBmYWxzZSxcbiAgICAgICAgYXVkaW9RdWV1ZTogc3RhdGUuYXVkaW9RdWV1ZS5zbGljZSgxKVxuICAgICAgfSkpO1xuICAgICAgZ2V0KCkucGxheU5leHRJblF1ZXVlKCk7XG4gICAgfVxuICB9XG59KSk7Il0sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLGNBQWM7QUFDdkIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsY0FBYztBQUV2QixNQUFNLFNBQVMsSUFBSSxPQUFPO0FBQUEsRUFDeEIsUUFBUSxPQUFPO0FBQUEsRUFDZix5QkFBeUI7QUFDM0IsQ0FBQztBQTRCTSxhQUFNLGdCQUFnQixPQUFtQixDQUFDLEtBQUssU0FBUztBQUFBLEVBQzdELGFBQWE7QUFBQSxFQUNiLGNBQWM7QUFBQSxFQUNkLGNBQWM7QUFBQSxFQUNkLGFBQWE7QUFBQSxFQUNiLFlBQVk7QUFBQSxFQUNaLGtCQUFrQjtBQUFBLEVBQ2xCLGVBQWU7QUFBQSxFQUNmLG1CQUFtQjtBQUFBLEVBQ25CLFlBQVksQ0FBQztBQUFBLEVBQ2IsYUFBYTtBQUFBLEVB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