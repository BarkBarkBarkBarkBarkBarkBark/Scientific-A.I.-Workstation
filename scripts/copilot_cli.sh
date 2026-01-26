# NODE_OPTIONS=--use-system-ca NODE_EXTRA_CA_CERTS="$PWD/saw-workspace/certs/macos-keychain.pem" \
# copilot -p "hello, can you tell me about yourself" \
#   --model gpt-5.2 \
#   --allow-all-tools \
#   --allow-url github.com \
#   --silent \
#   --log-level info || true

NODE_OPTIONS=--use-system-ca NODE_EXTRA_CA_CERTS="$PWD/saw-workspace/certs/macos-keychain.pem" \
copilot