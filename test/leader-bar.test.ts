// Drive the actual Bash bar through a private PTY, never through a Herdr pane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exercise = String.raw`
import os, sys, pty, subprocess, tempfile, json, time, select, termios, fcntl, struct, signal, re, unicodedata
bar, scenario = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='pack-bar-') as root:
    os.mkdir(root + '/bin')
    log = root + '/calls'
    fail = root + '/fail'
    fake = root + '/bin/pack-leader'
    with open(fake, 'w') as f:
        f.write('''#!/usr/bin/env python3
import os, sys, json
with open(os.environ['CALL_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
if os.path.exists(os.environ['FAIL_FILE']):
    print('missing leader pane\\x1b[2J\\nretry possible', file=sys.stderr)
    sys.exit(7)
''')
    os.chmod(fake, 0o755)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 2, 40, 0, 0))
    original = termios.tcgetattr(slave)
    env = {'PATH': os.environ['PATH'], 'HOME': root, 'TERM': 'xterm-256color',
           'HERDR_PLUGIN_ROOT': root, 'PACK_RUN_ID': "run 'with spaces'", 'PACK_WORKER': 'worker',
           'PACK_OBJECTIVE': 'a long objective ' * 10, 'PACK_WHERE': '/very/long/' * 10,
           'PACK_TASK': 'task ' * 50, 'CALL_LOG': log, 'FAIL_FILE': fail}
    proc = subprocess.Popen(['/bin/bash', bar], stdin=slave, stdout=slave, stderr=slave, env=env)
    output = bytearray()
    def drain(seconds=.15):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            ready, _, _ = select.select([master], [], [], max(0, until-time.monotonic()))
            if ready:
                try: output.extend(os.read(master, 65536))
                except OSError: break
    def calls():
        if not os.path.exists(log): return []
        with open(log) as f: return [json.loads(line) for line in f if line.strip()]
    def send(data, count):
        os.write(master, data)
        until = time.monotonic() + 3
        while len(calls()) < count and time.monotonic() < until: drain(.02)
        drain()
        assert len(calls()) == count, (data, calls(), bytes(output))
    try:
        until = time.monotonic() + 3
        while b'Back to leader' not in output and time.monotonic() < until: drain(.02)
        assert b'Back to leader' in output, bytes(output)
        if scenario == 'keys':
            for count, key in enumerate([b'o', b'\r', b' ', b'\n'], 1): send(key, count)
        elif scenario == 'release':
            send(b'\x1b[<0;4;1m', 1)
        elif scenario == 'resize':
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 2, 20, 0, 0))
            proc.send_signal(signal.SIGWINCH)
            drain()
            send(b'o', 1)
        elif scenario == 'mouse':
            # Navigate on release: a focus-on-press by the host must happen first.
            send(b'\x1b[<0;4;1M', 0)
            send(b'\x1b[<0;4;1m', 1)
            send(b'\x1b[<0;4;1m', 2)  # first click with only release forwarded
            send(b'\x1b[<0;4;2M\x1b[<0;4;2m', 3)
            send(b'\x1b[<2;4;1M\x1b[<2;4;1m\x1b[<64;4;1M', 3)
        elif scenario == 'failure':
            open(fail, 'w').close()
            mark = len(output)
            send(b'o', 1)
            error = bytes(output[mark:])
            assert b'failed' in error.lower(), error
            assert b'missing leader pane' in error, error
            # The CLI's own escape sequence must not reach the terminal.
            assert b'pane\x1b[2J' not in error, error
            os.unlink(fail)
            send(b'\r', 2)
            assert bytes(output).rfind(b'Back to leader') > bytes(output).rfind(b'missing leader pane')
        elif scenario == 'input':
            send(b'\x1b[A\x1b[<0;0;1m\x1b[<0;4;3m', 0)
            os.write(master, b'\x1b[')
            drain(1.2)  # an incomplete sequence must not swallow retries forever
            send(b'o', 1)
        elif scenario == 'signal':
            proc.send_signal(signal.SIGTERM)
        if scenario != 'signal': os.write(master, b'q')
        proc.wait(timeout=3)
        drain()
        assert proc.returncode == 0, (proc.returncode, bytes(output))
        restored = termios.tcgetattr(slave)
        # macOS tcsetattr sets the transient kernel PENDIN (retype pending input)
        # bit. Compare every configured mode and control character, not that bit.
        restored[3] &= ~getattr(termios, 'PENDIN', 0)
        original[3] &= ~getattr(termios, 'PENDIN', 0)
        assert restored == original, ('terminal modes not restored', original, restored)
        assert b'\x1b[?1006l\x1b[?1000l\x1b[?25h' in output, bytes(output)
        for call in calls(): assert call == ['leader', '--run', "run 'with spaces'"], call
        # No wrapping in a two-row PTY: long metadata must not scroll the button.
        for index, frame in enumerate(bytes(output).decode().split('\x1b[H\x1b[2J')[1:]):
            width = 20 if scenario == 'resize' and index > 0 else 40
            for row in frame.split('\x1b[2;1H'):
                text = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', row)
                cells = sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in text)
                assert cells < width, (width, cells, text)
        print(json.dumps({'scenario': scenario, 'calls': len(calls())}))
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)
        os.close(master)
        os.close(slave)
`;

for (const scenario of ["keys", "mouse", "release", "resize", "failure", "input", "signal"]) {
  test(`leader bar PTY: ${scenario}`, { timeout: 15_000 }, async () => {
    const { stdout } = await promisify(execFile)("python3", ["-c", exercise, resolve(import.meta.dirname, "../bin/leader-bar"), scenario], { timeout: 12_000 });
    assert.equal(JSON.parse(stdout).scenario, scenario);
  });
}
