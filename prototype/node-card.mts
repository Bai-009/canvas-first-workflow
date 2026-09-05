import { element } from "../web/dom.mjs";
(function () {
    var stage  = element(document, '#stage');
    var world  = element(document, '#world');
    var picker = element(document, '#picker');
    var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    var NOTE = '平台没有按落库时间筛选的节点，这一步只圈定目录范围。';
    // 三种料：死字 / 模型填的值 / 还没定的那一格
    var LINE: ({t:'text'|'val';s:string}|{t:'slot'})[] = [
      { t: 'text', s: '读取 ' },
      { t: 'slot' },
      { t: 'text', s: ' 里所有 ' },
      { t: 'val',  s: '.pdf' },
      { t: 'text', s: ' 文件' }
    ];

    var CPS = 46;                                   // 字宽/秒，全角算 2
    var wide = function (ch: string) { return /[⺀-￿]/.test(ch) ? 2 : 1; };
    var timers: ReturnType<typeof setTimeout>[] = [];
    var sleep = function (ms: number) {
      return new Promise<void>(function (r) { timers.push(setTimeout(r, reduce ? 1 : ms)); });
    };

    var PLUG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h16M4 8.5v7a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-7M8.5 8.5v-4M15.5 8.5v-4"/></svg>';

    async function typeInto(el: HTMLElement, text: string) {
      for (var i = 0; i < text.length; i++) {
        el.textContent = text.slice(0, i + 1);
        await sleep(1000 * wide(text.charAt(i)) / CPS);
      }
    }

    /* 高度不能硬跳：先把 auto 量出来，再从 176 springs 过去。 */
    function openTo(card: HTMLElement) {
      var keep = card.style.transition;
      card.style.transition = 'none';
      card.style.height = 'auto';
      var h = card.offsetHeight;
      card.style.height = '176px';
      void card.offsetHeight;
      card.style.transition = keep;
      card.style.height = h + 'px';
    }

    var slotEl: HTMLButtonElement | null = null;

    /* V6 的规矩:上台的东西要从它来的地方长出来。把变形原点挪到你点的那一格上,
       面板就是从那个洞里撑开的,不是凭空淡进来的。 */
    function openPicker() {
      if (!slotEl) return;
      var panel = element(picker, '.panel');
      var s = slotEl.getBoundingClientRect();
      var p = panel.getBoundingClientRect();
      panel.style.transformOrigin =
        (s.left + s.width / 2 - p.left) + 'px ' + (s.top + s.height / 2 - p.top) + 'px';
      picker.classList.add('on');
      world.classList.add('recede');
      panel.focus();
    }
    function closePicker() {
      picker.classList.remove('on');
      world.classList.remove('recede');
    }
    async function fill(value: string, count: string) {
      if (!slotEl) return;
      closePicker();
      slotEl.classList.remove('pop');
      void slotEl.offsetWidth;
      slotEl.className = 'slot filled pop';
      slotEl.textContent = value;
      var c2 = element(document, '#c2');
      openTo(c2);                                   // 句子变长了，框跟着长
      element(document, '#hint').innerHTML = '句子读通了';
      await sleep(1100);
      element(document, '#c2mark').textContent = '✓';
      var done = element(document, '#c2evi');
      done.className = 'mini-evi';
      done.textContent = count;
      c2.classList.remove('open');                  // 收回去
      c2.style.height = '';
      element(document, '#hint').innerHTML = '已收起，扫到多少落在小卡上。<b>点卡片可再展开</b>';
    }

    async function run() {
      timers.forEach(clearTimeout); timers = [];
      closePicker();
      var c1 = element(document, '#c1'), c2 = element(document, '#c2');
      var wire = element<SVGPathElement>(document, '#wire'), sock = element<SVGCircleElement>(document, '#sock');
      var note = element(document, '#note'), ln = element(document, '#ln1');
      var foot = element(document, '#foot');

      c1.className = 'card'; c2.className = 'card'; c2.style.height = '';
      wire.classList.remove('on'); sock.classList.remove('on');
      note.textContent = ''; ln.innerHTML = ''; foot.classList.remove('on');
      element(document, '#c2mark').innerHTML = '';
      var reset = element(document, '#c2evi');
      reset.className = 'mini-evi';
      reset.textContent = '';
      element(document, '#hint').innerHTML = '句子流完，点<b>那一格蓝色的</b>';

      await sleep(260);
      c1.classList.add('shown');
      await sleep(700);
      wire.classList.add('on');                     // 线先到
      await sleep(420);
      c2.classList.add('shown');                    // 卡从线的尽头长出来
      await sleep(720);
      c2.classList.add('open'); openTo(c2);         // 弹开
      sock.classList.add('on');
      await sleep(560);

      await typeInto(note, NOTE);                   // 旁白先出
      await sleep(280);

      for (var i = 0; i < LINE.length; i++) {       // 正文一段一段流出来
        var seg = LINE[i]; if (!seg) continue;
        if (seg.t === 'slot') {
          slotEl = document.createElement('button');
          slotEl.type = 'button';
          slotEl.className = 'slot pop';
          slotEl.innerHTML = PLUG + '<span>选数据源</span>';
          slotEl.addEventListener('click', openPicker);
          ln.appendChild(slotEl);
          await sleep(460);
        } else {
          var s = document.createElement('span');
          if (seg.t === 'val') s.className = 'val';
          ln.appendChild(s);
          await typeInto(s, seg.s);
        }
      }
      await sleep(300);
      foot.classList.add('on');                     // 上游最后落
      await sleep(260);
      element(document, '#c2mark').innerHTML = '<span class="dot-c"></span>';
      var evi = element(document, '#c2evi');
      evi.className = 'mini-evi pending';
      evi.textContent = '待定 1 项';                 // 状态,不是对用户说的话
    }

    element(document, '#c2').addEventListener('click', function () {
      if (this.classList.contains('open')) return;
      this.classList.add('open');
      openTo(this);
    });

    picker.addEventListener('click', function (e) {
      if (e.target === picker) return closePicker();
      if (!(e.target instanceof Element)) return;
      var row = e.target.closest<HTMLElement>('.src-row');
      if (row) return fill(row.dataset.v ?? "", row.dataset.n ?? "");
      if (e.target.closest('#drop')) return fill('刚上传的文件', '3 份 PDF');
      if (e.target.closest('#newconn')) return closePicker();
      if (e.target.closest('#pclose')) return closePicker();
    });
    addEventListener('keydown', function (e) { if (e.key === 'Escape') closePicker(); });

    function fit() {
      world.style.setProperty('--k', String(Math.min(1, (stage.clientWidth - 40) / 800)));
    }
    fit();
    addEventListener('resize', fit);

    element(document, '#replay').addEventListener('click', run);
    run();
  })();
