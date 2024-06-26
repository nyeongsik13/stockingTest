# 사용할 Node.js 이미지를 가져옵니다.
FROM node:latest

# ARG로 변수 선언
ARG DATABASE_URL
ARG DATABASE_HOST
ARG DATABASE_PORT
ARG DATABASE_NAME
ARG DATABASE_USERNAME
ARG DATABASE_PASSWORD
ARG PORT
ARG appKey
ARG secreKey
ARG SLACK_WEBHOOK_URL
ARG USER
ARG PASS
ARG JWT_SECRET
ARG GOOGLE_SECRET
ARG GOOGLE_ID
ARG NAVER_ID
ARG NAVER_SECRET
ARG KAKAO_ID
ARG BACKEND_URL
ARG FRONTEND_URL

# ENV로 환경 변수 설정
ENV DATABASE_URL=$DATABASE_URL \
    DATABASE_HOST=$DATABASE_HOST \
    DATABASE_PORT=$DATABASE_PORT \
    DATABASE_NAME=$DATABASE_NAME \
    DATABASE_USERNAME=$DATABASE_USERNAME \
    DATABASE_PASSWORD=$DATABASE_PASSWORD \
    PORT=$PORT \
    appKey=$appKey \
    secretKey=$secretKey \
    SLACK_WEBHOOK_URL=$SLACK_WEBHOOK_URL \
    USER=$USER \
    PASS=$PASS \
    JWT_SECRET=$JWT_SECRET \
    GOOGLE_SECRET=$GOOGLE_SECRET \
    GOOGLE_ID=$GOOGLE_ID \
    NAVER_ID=$NAVER_ID \
    NAVER_SECRET=$NAVER_SECRET \
    KAKAO_ID=$KAKAO_ID \
    BACKEND_URL=$BACKEND_URL \
    FRONTEND_URL=$FRONTEND_URL

    # 작업 디렉토리를 설정합니다.
WORKDIR /app

# 외부 패키지 설치를 위해 package.json과 yarn.lock 파일 복사
COPY main/package.json .
COPY main/yarn.lock .

# 앱을 실행하기 위해 필요한 모듈을 설치합니다.
RUN yarn install

# 프로젝트 파일을 Docker 컨테이너의 작업 디렉토리로 복사합니다.
COPY main .

ADD     . /app
RUN yarn prisma generate --schema=./main/prisma/schema.prisma
# 하기 포트를 외부로 노출합니다.

# 앱을 실행합니다.
CMD ["yarn", "dev"]

