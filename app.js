async function processPRs() {
  const fetchBtn = document.getElementById('fetchBtn');
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Loading...';

  const errorEl = document.getElementById('error');
  const outputSection = document.getElementById('output-section');
  const outputEl = document.getElementById('output');

  // Before fetch, clear errors and output:
  errorEl.style.display = 'none';
  outputSection.style.display = 'none';

  try {
    await fetchAndOutputPRs();

    // On success, show results:
    outputSection.style.display = 'block';
  } catch (error) {
    // On failure, show errors:
    errorEl.style.display = 'block';
    errorEl.innerText = `${error}`;
    outputSection.style.display = 'none';
  }

  // Restore button after completion
  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Fetch';
}

async function fetchPullRequestData(owner, repo, prNumber, accessToken) {
  const headers = { Authorization: `token ${accessToken}` };

  const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
  const prData = await prResponse.json();

  const filesResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, { headers });
  const filesData = await filesResponse.json();

  const commentsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, { headers });
  const prCommentsData = await commentsResponse.json();

  const reviewCommentsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`, { headers });
  const reviewCommentsData = await reviewCommentsResponse.json();
  const commentsData = [...prCommentsData, ...reviewCommentsData];

  const reviewersSet = new Set([prData.user.login]);
  commentsData.forEach(c => reviewersSet.add(c.user.login));

  return {
    owner, repo, prNumber, prData, filesData, commentsData, reviewCommentsData, reviewersSet
  };
}

async function fetchPullRequestsInBatches(prInfos, accessToken, batchSize) {
  const results = [];
  for (let i = 0; i <= prInfos.length; i += batchSize) {
    const batch = prInfos.slice(i, i + batchSize);
    const promises = batch.map(({ owner, repo, prNumber }) => (
      fetchPullRequestData(owner, repo, prNumber, accessToken)
    ));
    const batchData = await Promise.all(promises);
    batchData.forEach((r) => results.push(r));
  }
  return results;
}

async function fetchAndOutputPRs() {
  const tokenEl = document.getElementById('token');
  const accessToken = tokenEl.value.trim();

  const prLinksRaw = document.getElementById('prLinks').value.split('\n');
  const outputEl = document.getElementById('output');
  let invalidLinks = [];
  let result = '';

  const seenPRs = new Set();
  const prInfos = [];

  prLinksRaw.forEach((line, idx) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;
    const match = trimmedLine.match(/github\.com\/(.+?)\/(.+?)\/pull\/(\d+)/);
    if (!match) {
      invalidLinks.push(`Line ${idx + 1}: ${trimmedLine}`);
    } else {
      const [_, owner, repo, prNumber] = match;
      const uniqueKey = `${owner}/${repo}/${prNumber}`;
      if (!seenPRs.has(uniqueKey)) {
        seenPRs.add(uniqueKey);
        prInfos.push({ owner, repo, prNumber });
      }
    }
  });

  if (invalidLinks.length > 0) {
    throw new Error(`Invalid PR links:\n${invalidLinks.join('\n')}`);
  }

  if (prInfos.length === 0) {
    throw new Error('No pull requests provided.')
  }

  if (!accessToken || accessToken.length === 0) {
    throw new Error('No GitHub access token provded.')
  }

  const allPullRequestData = await fetchPullRequestsInBatches(prInfos, accessToken, 5);

  for (const fetchedData of allPullRequestData) {
    const {
      owner, repo, prNumber, prData, filesData, commentsData, reviewCommentsData, reviewersSet
    } = fetchedData;

    result += `Title: ${prData.title}\nAuthor: ${prData.user.login}\nReviewer(s): ${Array.from(reviewersSet).join(', ')}\n\nDescription:\n${prData.body || 'No description provided.'}\n\n`;

    result += `Files changed:\n`;
    for (const file of filesData) {
      result += `- ${file.filename}\nDiff:\n${file.patch}\n`;

      const inlineComments = reviewCommentsData.filter(c => c.path === file.filename && c.diff_hunk).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const threads = {};
      inlineComments.forEach(comment => {
        if (!comment.in_reply_to_id) threads[comment.id] = { comment, replies: [] };
        else if (threads[comment.in_reply_to_id]) threads[comment.in_reply_to_id].replies.push(comment);
      });

      Object.values(threads).forEach(({ comment, replies }) => {
        result += `> Comment by ${comment.user.login} at ${comment.created_at}\n${comment.body}\n\n`;
        replies.forEach(reply => {
          const replyIndented = reply.body.split('\n').map(l => '  ' + l).join('\n');
          result += `  > Reply by ${reply.user.login} at ${reply.created_at}\n${replyIndented}\n\n`;
        });
      });

      result += '\n';
    }

    const nonInlineComments = commentsData.filter(c => !c.path && !c.diff_hunk).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const outerThreads = {};
    nonInlineComments.forEach(comment => {
      if (!comment.in_reply_to_id) outerThreads[comment.id] = { comment, replies: [] };
      else if (outerThreads[comment.in_reply_to_id]) outerThreads[comment.in_reply_to_id].replies.push(comment);
    });

    Object.values(outerThreads).forEach(({ comment, replies }) => {
      result += `> Comment by ${comment.user.login} at ${comment.created_at}\n${comment.body}\n\n`;
      replies.forEach(reply => {
        const replyIndented = reply.body.split('\n').map(l => '  ' + l).join('\n');
        result += `  > Reply by ${reply.user.login} at ${reply.created_at}\n${replyIndented}\n\n`;
      });
    });

    result += '\n' + '-'.repeat(80) + '\n\n';
  }

  outputEl.textContent = result;
  const sizeMB = (new Blob([result]).size / (1024 * 1024)).toFixed(2);
  document.getElementById('downloadBtn').textContent = `Download (${sizeMB} MB)`;
}

function downloadTxt() {
  const text = document.getElementById('output').textContent;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `pull_requests_${timestamp}.txt`;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function copyToClipboard() {
  const text = document.getElementById('output').textContent;
  const copyBtn = document.getElementById('copyBtn');
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => copyBtn.textContent = 'Copy to Clipboard', 2000);
  });
}