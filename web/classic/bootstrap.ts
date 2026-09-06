/* 同步启动壳：文件预览提示和连接失败时的草稿恢复。 */
(() => {
    const notice = document.getElementById("boot-notice");
    if (!notice) throw new Error("缺少启动提示区域");
    if (location.protocol === "file:") {
      notice.hidden = false;
      notice.innerHTML = '这是文件预览，无法发送或保存工作流。请使用 <a href="http://127.0.0.1:5174/">打开工作流服务</a>。';
    } else {
      notice.hidden = true;
      const entry = "./main.mjs";
      import(entry).catch(() => {
        notice.hidden = false;
        notice.textContent = "未能连接工作流服务，输入的文字仍保留在这里。连接恢复后可以重试。";
        const retry = document.createElement("button"); retry.textContent = "重新连接";
        retry.onclick = () => { try { sessionStorage.setItem("canvasflow:boot-draft", document.querySelector<HTMLTextAreaElement>("#input")?.value ?? ""); } catch {} location.reload(); };
        notice.append(retry);
      });
    }

})();
