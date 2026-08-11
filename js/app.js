async function clearChat(coachId) {
  try {
    const snap = await db.collection("chats").doc(coachId).collection("messages").get();