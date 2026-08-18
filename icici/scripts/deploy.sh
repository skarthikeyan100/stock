#!/bin/bash

# Server deployment script
# Syncs data folder to remote server

REMOTE_HOST="139.59.4.137"
REMOTE_USER="karthik"
REMOTE_PATH="~/icici"
LOCAL_SERVER_PATH="/home/karthikeyan/work/icici"

echo "========================================="
echo "Server Deployment"
echo "========================================="
echo ""

echo "Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"
echo ""

npx tsc
if [ $? -ne 0 ]; then
  echo "TypeScript compilation failed!"
  exit 1
fi
echo "Server compiled successfully"
echo ""

echo "Building frontend..."
cd "${LOCAL_SERVER_PATH}/frontend"
npm run build
if [ $? -ne 0 ]; then
  echo "Frontend build failed!"
  exit 1
fi
echo "Frontend built successfully"
echo ""
cd "${LOCAL_SERVER_PATH}"

rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '*.log' \
  --exclude '.git' \
  "${LOCAL_SERVER_PATH}/" \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"

if [ $? -eq 0 ]; then
  echo ""
  echo "========================================="
  echo "Deployment successful!"
  echo "========================================="
  echo ""
  echo "Server files deployed to: ${REMOTE_HOST}:${REMOTE_PATH}"
  echo ""
  echo "Next steps on remote server:"
  echo "  ssh ${REMOTE_USER}@${REMOTE_HOST}"
  echo "  cd ~/icici"
  echo "  npm install"
  echo "  cd frontend && npm install && cd .."
  echo ""
  echo "To start with pm2 (first time):"
  echo "  pm2 start dist/server.js --name icici"
  echo "  pm2 save"
  echo "  pm2 startup   # follow the printed command to enable auto-start on reboot"
  echo ""
  echo "To restart after subsequent deployments:"
  echo "  pm2 restart icici"
  echo ""
  echo "Note: the frontend is served as static files by the Express server"
  echo "  (built output is in public/app/, no separate process needed)"
  echo "  Access at: http://${REMOTE_HOST}:3000/app/"
  echo ""
  echo "Other useful pm2 commands:"
  echo "  pm2 logs icici       # tail live logs"
  echo "  pm2 status           # check process status"
  echo "  pm2 stop icici       # stop the server"
  echo ""
else
  echo ""
  echo "Deployment failed!"
  exit 1
fi
