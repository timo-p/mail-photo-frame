# mail-photo-frame

Creates a webpage that shows a slideshow of images. The images are taken from a given email address attachments and uploaded to S3.

## Installation

### Create the CloudFront authetication lambda

Create a CloudFormation stack on US-EAST-1 region with the _auth-lambda-template-yaml_ file.

Provide the username, password and the user agent string that is allowed to bypass authentication.

Navigate to the created lambda function and publish a new version. Copy the arn of the created lambda version, you will need it when creating the serverless deployment.

### Create the serverless app

Install dependencies `npm install`

Fill _parameters.yml_ with required parameter values.

Deploy app. For example: `serverless deploy --stage dev`

Upload the static webpage in _public_ folder to the created S3 bucket. For example: `aws s3 cp public/ s3://mail-photo-frame-frontend-dev/ --recursive`
