#!/bin/bash
APP_ROOT_DIR=$(cd $(dirname "${BASH_SOURCE[0]}")/..; pwd)

SYSTEM="$(uname -o)"
if [ $SYSTEM == "Msys" ]
then
    export MSYS2_ARG_CONV_EXCL="*"
    APP_ROOT_DIR="$(cygpath -w $APP_ROOT_DIR)"
    echo "Msys"
fi

# # Build amd64 artifact
# docker buildx build --platform=linux/amd64 --target build-amd64 -t kuzu-lite:build-amd64 -f ${APP_ROOT_DIR}/Dockerfile ./

# # Extract amd64 prebuilt file
# docker create --name extract-amd64 kuzu-lite:build-amd64
# docker cp extract-amd64:/app/node_modules/kuzu/prebuilt/kuzujs-alpine-amd64.node ./prebuilt/
# docker rm extract-amd64

# Build arm64 artifact
# docker run --rm --privileged multiarch/qemu-user-static --reset -p yes

if ! docker buildx inspect myarmbuilder &>/dev/null; then
    docker buildx create --name myarmbuilder --platform linux/arm64 --use
else
    docker buildx use myarmbuilder
fi
docker buildx build --platform=linux/arm64 --target build-arm64 -t kuzu-lite:build-arm64 -f ${APP_ROOT_DIR}/Dockerfile ./

# Extract arm64 prebuilt file
docker create --name extract-arm64 kuzu-lite:build-arm64
docker cp extract-arm64:/app/node_modules/kuzu/prebuilt/kuzujs-alpine-arm64.node ./prebuilt/
docker rm extract-arm64

echo "All prebuilt files have been extracted to ./prebuilt/"

run_test() {
    local arch=$1
    local node_file=$2
    
    echo "Running tests on $arch architecture..."
    docker run --rm \
        --platform linux/$arch \
        -v "${APP_ROOT_DIR}:/kuzu-lite" \
        node:18-alpine /bin/sh -c "
            cd /kuzu-lite && \
            cp -f /kuzu-lite/prebuilt/$node_file /kuzu-lite/kuzujs.node && \
            cd /kuzu-lite/util && \
            node ./test.js 
        "
}


# Run tests for different architectures
run_test "amd64" "kuzujs-alpine-amd64.node"
run_test "arm64" "kuzujs-alpine-arm64.node"

echo "All tests completed successfully!"

echo "Please use 'yarn release' to release the package to npm!"